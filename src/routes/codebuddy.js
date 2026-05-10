/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * @module routes/codebuddy
 */

import {createChatCompletions, getModels} from '../services/codebuddy/api.js';
import {anthropicToOpenAI, openAIToAnthropic, ClaudeStreamState, SSEWriter} from '../services/codebuddy/translator.js';
import {authenticateRequest, getCredential} from '../services/codebuddy/auth.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {DEFAULT_BASE_URL} from '../services/codebuddy/config.js';
import logger from '../utils/logger.js';

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送 OpenAI 格式的错误响应
 */
function sendOpenAIError(res, status, message, type = 'api_error') {
    const errorResponse = {
        error: {
            message: message,
            type: type,
            code: status
        }
    };
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(errorResponse));
}

/**
 * 发送 Anthropic 格式的错误响应
 */
function sendAnthropicError(res, status, message) {
    const errorResponse = {
        type: 'error',
        error: {
            type: status === 401 ? 'authentication_error' : 'api_error',
            message: message
        }
    };
    sendJson(res, status, errorResponse);
}

/**
 * 鉴权并获取凭证
 */
function authenticateAndGetCredential(headers) {
    const authResult = authenticateRequest(headers);

    if (!authResult.authenticated) {
        return {
            error: {
                status: 401,
                message: authResult.error
            }
        };
    }

    const credential = getCredential();

    if (!credential) {
        return {
            error: {
                status: 503,
                message: 'No available credentials'
            }
        };
    }

    return {credential};
}

/**
 * 解析请求体
 */
async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 处理 OpenAI 格式的 /v1/chat/completions 请求 - 直接透传
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req.headers);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        // 解析 OpenAI 格式的请求
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        // 请求上游在流式响应末尾返回 usage
        openAIPayload.stream_options = {include_usage: true};

        // 直接调用 CodeBuddy API（已经是 OpenAI 格式）
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        // 直接透传响应
        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

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
                    } catch {}
                }
            });

            response.body.on('end', () => {
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Stream error:', err);
                res.end();
            });
        } else {
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens);
            credentialStore.recordDailyUsage(inputTokens, outputTokens);

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
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            sendJson(res, 200, openAIResponse);
        }
    } catch (error) {
        logger.error('Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI 格式的 /v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req.headers);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const modelsData = await getModels(authResult.credential);

        // 返回 OpenAI 格式
        sendJson(res, 200, {
            object: 'list',
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: model.vendor || 'codebuddy'
            }))
        });
    } catch (error) {
        logger.error('Failed to get OpenAI models:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req.headers);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        // 解析 Anthropic 格式的请求
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        // 请求上游在流式响应末尾返回 usage
        openAIPayload.stream_options = {include_usage: true};

        // 调用 CodeBuddy API
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        // 判断是否为流式响应
        if (anthropicPayload.stream) {
            // 流式响应
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

            const responseBody = response.body;

            responseBody.on('data', (chunk) => {
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

                    // 提取推理文本：delta.thinking 可能是字符串或对象 { content, signature }
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

                    if (reasoningText) {
                        state.appendThinking(reasoningText);
                    }
                    if (signature) {
                        state.closeThinking(signature);
                    }

                    if (Array.isArray(delta?.tool_calls)) {
                        for (const tool of delta.tool_calls) {
                            const idx = tool.index;
                            if (tool.function?.name) {
                                // 传入 kimi 返回的原始 tool.id，保证 tool_use_id 与上游 tool_call_id 一致
                                // 否则 Claude Code 下一轮 tool_result 携带的 id 将无法被 kimi 识别，导致 invoke model error
                                state.startTool(idx, tool.function.name, tool.id);
                            }
                            if (tool.function?.arguments) {
                                state.appendToolArgs(idx, tool.function.arguments);
                            }
                        }
                    }

                    // 判断是否有推理内容（使用已提取的 reasoningText 避免重复逻辑）
                    if (delta?.content && !reasoningText) {
                        partialTextBuffer += delta.content;
                    }

                    if (choice?.finish_reason) {
                        if (partialTextBuffer) {
                            state.appendText(partialTextBuffer);
                            partialTextBuffer = '';
                        }

                        if (choice.finish_reason === 'tool_calls') {
                            state.finalStopReason = 'tool_use';
                        } else if (choice.finish_reason === 'length') {
                            state.finalStopReason = 'max_tokens';
                        } else {
                            state.finalStopReason = 'end_turn';
                        }
                    }
                }

                if (start > 0) {
                    buffer = buffer.subarray(start);
                }
            });

            responseBody.on('end', () => {
                if (partialTextBuffer) {
                    state.appendText(partialTextBuffer);
                    partialTextBuffer = '';
                }
                state.endMessage(state.finalStopReason);
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens);
                res.end();
            });

            responseBody.on('error', (err) => {
                logger.error('Stream error:', err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
            });
        } else {
            // 非流式响应
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens);
            credentialStore.recordDailyUsage(inputTokens, outputTokens);

            const openAIResponse = {
                id: aggregated.id || `msg_${Date.now()}`,
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
                        finish_reason: aggregated.finishReason || 'stop',
                        logprobs: null
                    }
                ],
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            logger.info(
                `CodeBuddy response - content length: ${aggregated.content?.length || 0}, tool calls: ${aggregated.toolCalls.length}`
            );
            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req.headers);
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
        logger.error('Failed to count tokens:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req.headers);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(authResult.credential);

        sendJson(res, 200, {
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'codebuddy',
                name: model.name,
                capabilities: {}
            })),
            object: 'list'
        });
    } catch (error) {
        logger.error('Failed to get Anthropic models:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理凭证管理端点
 */
async function handleCredentials(req, res, method, pathname) {
    const tm = credentialStore.getTokenManager();

    try {
        // GET /v1/credentials - 列出所有凭证
        if (method === 'GET' && pathname === '/v1/credentials') {
            const credentials = tm.getCredentialsInfo();
            sendJson(res, 200, {credentials});
            return;
        }

        // GET /v1/credentials/current - 获取当前凭证
        if (method === 'GET' && pathname === '/v1/credentials/current') {
            const info = tm.getCurrentCredentialInfo();
            sendJson(res, 200, info);
            return;
        }

        // POST /v1/credentials - 添加新凭证
        if (method === 'POST' && pathname === '/v1/credentials') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (!data.bearer_token) {
                sendOpenAIError(res, 400, 'bearer_token is required');
                return;
            }

            const success = tm.addCredentialWithData(data, data.filename);
            if (success) {
                sendJson(res, 200, {message: 'Credential added successfully'});
            } else {
                sendOpenAIError(res, 500, 'Failed to save credential');
            }
            return;
        }

        // POST /v1/credentials/select - 手动选择凭证
        if (method === 'POST' && pathname === '/v1/credentials/select') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.setManualCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} selected successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid credential index');
            }
            return;
        }

        // POST /v1/credentials/auto - 恢复自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/auto') {
            tm.clearManualSelection();
            sendJson(res, 200, {message: 'Resumed automatic credential rotation'});
            return;
        }

        // POST /v1/credentials/toggle-rotation - 切换自动轮换
        if (method === 'POST' && pathname === '/v1/credentials/toggle-rotation') {
            const isEnabled = tm.toggleAutoRotation();
            sendJson(res, 200, {
                message: `Auto rotation ${isEnabled ? 'enabled' : 'disabled'}`,
                auto_rotation_enabled: isEnabled
            });
            return;
        }

        // POST /v1/credentials/delete - 删除凭证
        if (method === 'POST' && pathname === '/v1/credentials/delete') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const success = tm.deleteCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
            }
            return;
        }

        sendOpenAIError(res, 404, 'Credential endpoint not found');
    } catch (error) {
        logger.error('Credential management error:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    const tm = credentialStore.getTokenManager();
    const info = tm.getCurrentCredentialInfo();
    sendJson(res, 200, {
        name: 'CodeBuddy API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic'],
        authenticated: tm.hasCredentials(),
        currentCredential: info,
        endpoints: {
            openai: {
                chatCompletions: 'POST /codebuddy/v1/chat/completions - OpenAI format',
                models: 'GET /codebuddy/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /codebuddy/anthropic/v1/messages - Claude format',
                countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                models: 'GET /codebuddy/anthropic/v1/models - Claude format models'
            },
            credentials: 'GET/POST /codebuddy/v1/credentials - Manage credentials'
        },
        configuration: {
            autoRotation: tm.autoRotationEnabled,
            rotationCount: tm.rotationCount,
            credsDir: '.codebuddy'
        }
    });
}

/**
 * 主路由处理函数
 */
export async function routeCodebuddyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 凭证管理端点（两个模式共用）==========
    if (pathname.startsWith('/codebuddy/v1/credentials')) {
        return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
    }

    // ========== Anthropic 模式（Claude 格式）==========
    if (pathname.startsWith('/codebuddy/anthropic')) {
        const anthropicPath = pathname.replace('/codebuddy/anthropic', '');

        if (anthropicPath === '/v1/messages' && method === 'POST') {
            return handleAnthropicMessages(req, res);
        }

        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
            return handleAnthropicCountTokens(req, res);
        }

        if (anthropicPath === '/v1/models' && method === 'GET') {
            return handleAnthropicModels(req, res);
        }

        // Anthropic 模式的根路径
        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'CodeBuddy API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /codebuddy/anthropic/v1/messages',
                    countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                    models: 'GET /codebuddy/anthropic/v1/models'
                }
            });
            return;
        }

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式（默认）==========
    // 注意：所有非 anthropic 路径都走 OpenAI 模式

    if (pathname === '/codebuddy/v1/chat/completions' && method === 'POST') {
        return handleOpenAIChatCompletions(req, res);
    }

    if (pathname === '/codebuddy/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // OpenAI 模式的根路径
    if (pathname === '/codebuddy' || pathname === '/codebuddy/') {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
