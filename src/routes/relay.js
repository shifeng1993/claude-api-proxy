/**
 * Relay 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/relay
 */

import {authenticateRequest} from '../services/relay/auth.js';
import {relayStore} from '../services/relay/relay-store.js';
import {createChatCompletions, getUpstreamModels} from '../services/relay/api.js';
import {readBody} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic,
    ClaudeStreamState,
    SSEWriter,
    injectBehaviorRules,
    mapStopReason
} from '../services/relay/translator.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import logger from '../utils/logger.js';

/* ==================== 工具函数 ==================== */

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendOpenAIError(res, status, message, type = 'api_error') {
    sendJson(res, status, {error: {message, type, code: status}});
}

function sendAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendJson(res, status, {type: 'error', error: {type: errorType, message}});
}

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function readResponseBody(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/* ==================== 鉴权 ==================== */

function authenticateAndGetUpstream(headers) {
    const authResult = authenticateRequest(headers);

    if (!authResult.authenticated) {
        return {error: {status: 401, message: authResult.error}};
    }

    const upstreamManager = relayStore.getUpstreamManager();
    if (!upstreamManager) {
        return {error: {status: 503, message: 'Relay upstream manager not found'}};
    }

    const upstream = upstreamManager.getActiveUpstream();
    if (!upstream) {
        return {error: {status: 503, message: '未配置可用上游，请在管理面板 /relayFE 配置'}};
    }

    return {upstream, upstreamManager};
}

/**
 * 对活跃上游进行重试
 */
async function retryUpstream(upstream, fn, upstreamManager) {
    const retryCount = upstreamManager ? upstreamManager.getUpstreamRetryCount(upstream.index) : 5;
    let lastError = null;
    for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
            const response = await fn(upstream);
            if (response.status >= 200 && response.status < 300) {
                return {response, upstream};
            }
            const errorBody = await readBody(response.body);
            const reason = `HTTP ${response.status}: ${errorBody.slice(0, 200)}`;
            lastError = new Error(`上游「${upstream.name}」返回 ${reason}`);
            if (attempt < retryCount) {
                logger.warn(`Relay: 上游「${upstream.name}」第${attempt}/${retryCount}次失败 - ${reason}，重试中...`);
            } else {
                logger.warn(`Relay: 上游「${upstream.name}」重试${retryCount}次耗尽: ${reason}`);
            }
        } catch (err) {
            lastError = err;
            if (attempt < retryCount) {
                logger.warn(
                    `Relay: 上游「${upstream.name}」第${attempt}/${retryCount}次异常 - ${err.message}，重试中...`
                );
            } else {
                logger.warn(`Relay: 上游「${upstream.name}」重试${retryCount}次耗尽: ${err.message}`);
            }
        }
    }
    throw lastError || new Error(`上游「${upstream.name}」不可用`);
}

function recordUsage(inputTokens, outputTokens) {
    relayStore.incrementApiCallCount();
    relayStore.incrementTokenUsage(inputTokens, outputTokens);
    relayStore.recordDailyUsage(inputTokens, outputTokens);
}

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式的 /relay/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const authResult = authenticateAndGetUpstream(req.headers);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        logger.info(
            `Relay OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}, 上游: ${upstream.name}`
        );

        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
        // 请求上游在流式响应末尾返回 usage
        if (openAIPayload.stream) {
            openAIPayload.stream_options = {include_usage: true};
        }
        const {response} = await retryUpstream(
            upstream,
            (up) => {
                const payload = {...openAIPayload, model: upstreamManager.resolveModel(openAIPayload.model, up.index)};
                return createChatCompletions(payload, up);
            },
            upstreamManager
        );

        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            _streamOpenAIPassthrough(response, res);
        } else {
            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                logger.error('Relay: failed to parse upstream non-stream response');
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }
            recordUsage(parsed.usage?.prompt_tokens || 0, parsed.usage?.completion_tokens || 0);
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        logger.error('Relay: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /relay/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const authResult = authenticateAndGetUpstream(req.headers);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, upstreamManager} = authResult;
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        if (anthropicPayload.stream) {
            openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
            openAIPayload.stream_options = {include_usage: true};
            const {response} = await retryUpstream(
                upstream,
                (up) => {
                    const payload = {
                        ...openAIPayload,
                        model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                    };
                    return createChatCompletions(payload, up, {
                        requestType: 'Anthropic',
                        stream: anthropicPayload.stream,
                        originalModel: anthropicPayload.model
                    });
                },
                upstreamManager
            );

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const writer = new SSEWriter(res);
            const state = new ClaudeStreamState(writer);
            let buffer = Buffer.alloc(0);
            let partialTextBuffer = '';
            let streamInputTokens = 0;
            let streamOutputTokens = 0;

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    let data;
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }

                    const choice = data.choices?.[0];
                    const delta = choice?.delta;

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                    }

                    state.startMessage(data.model);

                    let reasoningText = null;
                    let signature = null;
                    if (delta?.reasoning_content) {
                        reasoningText = delta.reasoning_content;
                    } else if (typeof delta?.thinking === 'string') {
                        reasoningText = delta.thinking;
                    } else if (typeof delta?.thinking === 'object' && delta.thinking !== null) {
                        reasoningText = delta.thinking.content || null;
                        signature = delta.thinking.signature || null;
                    } else if (delta?.thought) {
                        reasoningText = typeof delta.thought === 'string' ? delta.thought : null;
                    } else if (delta?.reasoning) {
                        reasoningText = typeof delta.reasoning === 'string' ? delta.reasoning : null;
                    }
                    if (!signature) {
                        signature =
                            delta?.reasoning_signature ||
                            (choice?.finish_reason === 'thinking' ? Date.now().toString() : null);
                    }
                    if (reasoningText) state.appendThinking(reasoningText);
                    if (signature) state.closeThinking(signature);

                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tool of delta.tool_calls) {
                            const idx = tool.index;
                            if (tool.function?.name) state.startTool(idx, tool.function.name, tool.id);
                            if (tool.function?.arguments) state.appendToolArgs(idx, tool.function.arguments);
                        }
                    }
                    if (delta?.content && !reasoningText) partialTextBuffer += delta.content;
                    if (choice?.finish_reason) {
                        if (partialTextBuffer) {
                            state.appendText(partialTextBuffer);
                            partialTextBuffer = '';
                        }
                        state.finalStopReason = mapStopReason(choice.finish_reason);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                if (partialTextBuffer) {
                    state.appendText(partialTextBuffer);
                    partialTextBuffer = '';
                }
                state.endMessage(state.finalStopReason);
                recordUsage(streamInputTokens, streamOutputTokens);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Relay Anthropic stream error:', err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，用 aggregateStreamResponse 聚合
            openAIPayload.stream = true;
            openAIPayload.stream_options = {include_usage: true};
            openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
            const {response} = await retryUpstream(
                upstream,
                (up) => {
                    const payload = {
                        ...openAIPayload,
                        model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                    };
                    return createChatCompletions(payload, up, {
                        requestType: 'Anthropic',
                        stream: false,
                        originalModel: anthropicPayload.model
                    });
                },
                upstreamManager
            );

            const aggregated = await aggregateStreamResponse(response.body);
            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            recordUsage(inputTokens, outputTokens);

            const openAIResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop'
                    }
                ],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };
            sendJson(res, 200, openAIToAnthropic(openAIResponse));
        }
    } catch (error) {
        logger.error('Relay: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 → OpenAI 上游） */
function _streamOpenAIPassthrough(response, res) {
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let lineBuffer = '';

    response.body.on('data', (chunk) => {
        res.write(chunk);
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const raw = trimmed.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
                const data = JSON.parse(raw);
                if (data.usage) {
                    streamInputTokens = data.usage.prompt_tokens || 0;
                    streamOutputTokens = data.usage.completion_tokens || 0;
                }
            } catch {
            }
        }
    });

    response.body.on('end', () => {
        recordUsage(streamInputTokens, streamOutputTokens);
        res.end();
    });

    response.body.on('error', (err) => {
        logger.error('Relay stream error:', err);
        res.end();
    });
}

/* ==================== 其他端点 ==================== */

async function handleOpenAIModels(req, res) {
    try {
        const authResult = authenticateAndGetUpstream(req.headers);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream);
        sendJson(res, 200, modelsData);
    } catch (error) {
        logger.error('Relay: Failed to get OpenAI models:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

async function handleAnthropicModels(req, res) {
    try {
        const authResult = authenticateAndGetUpstream(req.headers);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream);
        const anthropicModels = {
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: model.created || 0,
                owned_by: model.owned_by || model.owner || 'relay',
                name: model.id,
                capabilities: {}
            })),
            object: 'list'
        };
        sendJson(res, 200, anthropicModels);
    } catch (error) {
        logger.error('Relay: Failed to get Anthropic models:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = authenticateAndGetUpstream(req.headers);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);
        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);
        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Relay: Failed to count tokens:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/* ==================== 主路由 ==================== */

export async function routeRelayRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/relay' || pathname === '/') {
        sendJson(res, 200, {
            name: 'Relay API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            endpoints: {
                openai: {
                    chatCompletions: 'POST /relay/v1/chat/completions - OpenAI format',
                    models: 'GET /relay/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /relay/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models - Claude format models'
                }
            }
        });
        return;
    }

    if (pathname.startsWith('/relay/anthropic')) {
        const anthropicPath = pathname.replace('/relay/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Relay API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /relay/anthropic/v1/messages',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST')
            return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    if (pathname === '/relay/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/relay/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
