/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * 支持 Responses API WebSocket 端点
 * @module routes/codebuddy
 */

import {createChatCompletions, getModels} from '../services/codebuddy/api.js';
import {anthropicToOpenAI, openAIToAnthropic, ClaudeStreamState, SSEWriter} from '../services/codebuddy/translator.js';
import {rewriteOpenAIStream, injectBehaviorRules} from '../transformer/shared-translator.js';
import {
    responsesRequestToChat,
    chatResponseToResponses,
    createResponsesStreamState,
    chatChunkToResponsesEvents,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {authenticateRequest, getCredential} from '../services/codebuddy/auth.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/ws/ws-server.js';
import logger from '../utils/logger.js';
import {isNetworkError} from '../utils/http-client.js';

/**
 * 从上游 usage 中提取缓存命中 token 数
 * DeepSeek: prompt_cache_hit_tokens
 * OpenAI: prompt_tokens_details.cached_tokens
 */
function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

// 主要是处理codex兼容
export function mapCodebuddyModelName(model) {
    if (!model || typeof model !== 'string') return model;
    const lower = model.toLowerCase();
    if (lower.includes('codex')) return 'deepseek-v4-flash';
    if (lower.startsWith('gpt-')) {
        return lower.includes('mini') ? 'deepseek-v4-flash' : 'kimi-k2.6';
    }
    return model;
}

/**
 * 选择用于统计记录的模型名
 * 优先使用上游返回的模型名，但如果上游返回的是端点 ID（ep- 前缀）等不可读标识，
 * 则回退到客户端请求的模型名
 */
function pickModelName(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

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

function upstreamErrorStatus(err) {
    return isNetworkError(err) ? 502 : 500;
}

/**
 * 鉴权并获取凭证
 * 如果网关层已完成鉴权（req._gatewayAuthenticated），跳过后端 API Key 检查
 */
function authenticateAndGetCredential(req) {
    // 网关令牌已验证，直接通过
    if (req._gatewayAuthenticated) {
        const credential = getCredential();
        if (!credential) {
            return {error: {status: 503, message: 'No available credentials'}};
        }
        return {credential};
    }

    const authResult = authenticateRequest(req.headers);

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
        const authResult = authenticateAndGetCredential(req);
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
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);

        // 注入行为规则（统一在路由层注入一次）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

        // 直接调用 CodeBuddy API（已经是 OpenAI 格式）
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        // 流式响应：使用 rewriteOpenAIStream 对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个块
        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            rewriteOpenAIStream(res, response.body, (inputTokens, outputTokens, cacheHitTokens, credit, model) => {
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                credentialStore.incrementCreditUsage(credit);
                credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);
            });
        } else {
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);

            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

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
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI 格式的 /v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
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
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        // 解析 Anthropic 格式的请求
        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);
        openAIPayload.model = mapCodebuddyModelName(openAIPayload.model);

        // 注入行为规则（translateMessages 不再内部注入，统一在路由层注入一次）
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);

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
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';

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
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

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
                state.endMessage(state.finalStopReason, {
                    inputTokens: streamInputTokens,
                    outputTokens: streamOutputTokens,
                    cacheHitTokens: streamCacheHitTokens
                });
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
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
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

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

            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
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
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
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
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI Responses API 请求 (/codebuddy/v1/responses)
 * 将 Responses 格式转为 Chat Completions 发给上游，再将响应转回 Responses 格式
 */
async function handleResponsesAPI(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        // Responses -> Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        chatReq.messages = injectBehaviorRules(chatReq.messages);

        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id'],
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id']
        });

        if (responsesReq.stream) {
            // 流式：解析 Chat SSE -> Responses SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';

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
                    try { data = JSON.parse(raw); } catch { continue; }

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

                    const events = chatChunkToResponsesEvents(data, streamState);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                // 如果没有正常完成，兜底发送 response.completed
                if (!streamState.started || !streamState.finished) {
                    if (streamState.reasoningOpen) {
                        res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]}})}\n\n`);
                        streamState.outputIndex++;
                    }
                    if (streamState.messageOpen) {
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item: {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]}})}\n\n`);
                    }
                    res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || 'unknown', output: [], usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                }
                credentialStore.incrementApiCallCount();
                credentialStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                credentialStore.incrementCreditUsage(streamCredit);
                credentialStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Responses stream error:', err);
                res.end();
            });
        } else {
            // 非流式
            const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
            const aggregated = await aggregateStreamResponse(response.body);

            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage?.credit || 0;
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.incrementCreditUsage(credit);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

            const chatResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || chatReq.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: aggregated.content || null,
                        reasoning_content: aggregated.reasoningContent || undefined,
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error('Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI Responses Compact 请求 (/codebuddy/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const authResult = authenticateAndGetCredential(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);
        chatReq.model = mapCodebuddyModelName(chatReq.model);
        chatReq.messages = injectBehaviorRules(chatReq.messages);

        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId: req.headers['x-conversation-id']
        });

        const {aggregateStreamResponse} = await import('../services/codebuddy/api.js');
        const aggregated = await aggregateStreamResponse(response.body);

        const inputTokens = aggregated.usage?.prompt_tokens || 0;
        const outputTokens = aggregated.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
        const credit = aggregated.usage?.credit || 0;
        credentialStore.incrementApiCallCount();
        credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        credentialStore.incrementCreditUsage(credit);
        credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, credit);

        const chatResponse = {
            id: aggregated.id || `chatcmpl_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: aggregated.model || chatReq.model,
            choices: [{
                index: 0,
                message: {role: 'assistant', content: aggregated.content || null},
                finish_reason: aggregated.finishReason || 'stop'
            }],
            usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
        };

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
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

            // 阻止使用已废弃域名
            try {
                const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
                if (BLOCKED_DOMAINS.includes(credentialHost)) {
                    sendOpenAIError(res, 400, `域名 ${credentialHost} 已废弃，不允许添加凭证`);
                    return;
                }
            } catch {
                // base_url 格式无效，由下游处理
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
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
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
                responses: 'POST /codebuddy/v1/responses - Responses API',
                responsesCompact: 'POST /codebuddy/v1/responses/compact - Responses Compact API',
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

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 CodeBuddy Responses API WebSocket 连接
 * 客户端通过 WS 连接 /codebuddy/v1/responses，发送标准 Responses API WS 协议
 * CodeBuddy 上游使用 OpenAI Chat HTTP，服务端做 WS→HTTP→WS 转换
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
export function handleCodebuddyResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: (req) => {
            if (req._gatewayAuthenticated) return true;
            const authResult = authenticateRequest(req.headers);
            return authResult.authenticated;
        },
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            const authData = authenticateRequest(req.headers);
            if (!authData.authenticated) {
                throw Object.assign(new Error('Authentication failed'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'Authentication failed', code: 'unauthorized'}}
                });
            }

            const credential = getCredential(authData.apiKey);
            if (!credential) {
                throw Object.assign(new Error('No valid CodeBuddy credentials'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'No valid CodeBuddy credentials', code: 'no_credentials'}}
                });
            }

            // Responses → Chat Completions 转换
            const mappedModel = mapCodebuddyModelName(payload.model);
            const chatReq = responsesRequestToChat({...payload, model: mappedModel});
            chatReq.messages = injectBehaviorRules(chatReq.messages);
            chatReq.stream = true;

            const response = await createChatCompletions(chatReq, {
                credential,
                conversationId: req.headers['x-conversation-id'],
                conversationRequestId: req.headers['x-conversation-request-id'],
                conversationMessageId: req.headers['x-conversation-message-id'],
                requestId: req.headers['x-request-id']
            });

            if (response.status >= 400) {
                throw Object.assign(new Error(`CodeBuddy API error: ${response.status}`), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: `Upstream error: ${response.status}`, code: 'upstream_error'}}
                });
            }

            // 将 Chat SSE 流转换为 Responses WS 事件
            const streamState = createResponsesStreamState();
            let buffer = Buffer.alloc(0);

            for await (const chunk of response.body) {
                if (signal?.aborted) break;
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try { data = JSON.parse(raw); } catch { continue; }

                    const events = chatChunkToResponsesEvents(data, streamState);
                    for (const ev of events) {
                        yield {type: ev.event, data: ev.data};
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            credentialStore.incrementApiCallCount();
            credentialStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            credentialStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
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

    if (pathname === '/codebuddy/v1/responses/compact' && method === 'POST') {
        return handleResponsesCompact(req, res);
    }

    if (pathname === '/codebuddy/v1/responses' && method === 'POST') {
        return handleResponsesAPI(req, res);
    }

    if (pathname === '/codebuddy/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // OpenAI 模式的根路径
    if (pathname === '/codebuddy' || pathname === '/codebuddy/' || pathname === '/codebuddy/v1' || pathname === '/codebuddy/v1/') {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
