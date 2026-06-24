/**
 * Copilot 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/copilot
 */

import {ensureCopilotToken, isAuthenticated} from '../services/copilot/auth.js';
import {createChatCompletions, createResponsesWS, releaseWSConnection, discardWSConnection, getModels} from '../services/copilot/copilot-api.js';
import {copilotState} from '../services/copilot/state.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {readBody} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    anthropicToResponses,
    openAIToAnthropic
} from '../services/copilot/anthropic-adapter.js';
import {
    chatRequestToResponses,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    convertResponsesUsageToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToAnthropicStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    extractCacheHitTokens,
    responsesRequestToChat,
    responsesResponseToChat,
    sanitizeAnthropicPayload,
    sanitizeResponsesInput
} from '../services/copilot/protocol-adapter.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../utils/token-estimation.js';
import {aggregateStreamResponse} from '../services/providers/index.js';
import {handleWSConnection} from '../services/shared/index.js';
import {
    currentCopilotContext,
    runCopilotTenantContext,
    runWithCopilotContext
} from '../services/copilot/runtime.js';
import {
    copilotUpstreamErrorStatus as upstreamErrorStatus,
    isCopilotResponsesProtocolError as isResponsesProtocolError,
    sendCopilotAnthropicError as sendAnthropicError,
    sendCopilotJsonResponse as sendJson,
    sendCopilotOpenAIError as sendOpenAIError,
    sendCopilotResponsesProtocolError as sendResponsesProtocolError
} from '../services/copilot/response-writer.js';
import {extractCopilotConversationKey as extractConversationKey} from '../services/copilot/conversation-key.js';
import {createCopilotNetworkOptionsResolver} from '../services/copilot/network-options.js';
import {createCopilotAuthResolver} from '../services/copilot/auth-context.js';
import {
    ensureCopilotResponsesWebSocketSupported as ensureResponsesWebSocketSupported,
    supportsCopilotResponsesWebSocket
} from '../services/copilot/model-support.js';
import {createCopilotMetadataHandlers} from '../services/copilot/metadata-handler.js';
import logger from '../utils/logger.js';

const getCopilotNetworkOptions = createCopilotNetworkOptionsResolver({store: copilotStore});
const ensureCopilotAuth = createCopilotAuthResolver({
    isAuthenticated,
    ensureCopilotToken,
    store: copilotStore
});

export const supportsResponsesWebSocket = supportsCopilotResponsesWebSocket;

/**
 * API Key 鉴权（已移除，统一由网关层处理）
 */

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const {
    handleOpenAIModels,
    handleAnthropicCountTokens,
    handleAnthropicModels
} = createCopilotMetadataHandlers({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    getModels,
    copilotState,
    sendOpenAIError,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    estimateMessageTokens,
    estimateContentBlockTokens,
    logger
});

/* ==================== OpenAI 模式 ==================== */

/**
 * 处理 OpenAI 格式的 /copilot/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        logger.info(`Copilot OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}`);

        const conversationKey = extractConversationKey(req, openAIPayload);

        // Chat → Responses 格式
        const responsesReq = chatRequestToResponses(openAIPayload);

        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const responsesToChatBridge = createResponsesToChatStreamBridge({model: openAIPayload.model});
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const chatChunks = responsesToChatBridge.feed(event.type, event.data);
                        for (const chunk of chatChunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                    if (!responsesToChatBridge.completed) {
                        for (const chunk of responsesToChatBridge.finish()) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                    res.write('data: [DONE]\n\n');
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const chatResponse = responsesResponseToChat(completedData.response);
                    const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                    const outputTokens = chatResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                    sendJson(res, 200, chatResponse);
                } else {
                    sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (res.headersSent) {
                logger.warn(`Copilot OpenAI: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot OpenAI: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const response = await createChatCompletions(
                copilotState.copilotToken,
                copilotState.vsCodeVersion,
                openAIPayload,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
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
                                streamCacheHitTokens = extractCacheHitTokens(data.usage);
                            }
                        } catch {}
                    }
                });

                response.body.on('end', () => {
                    if (lineBuffer.trim()) {
                        res.write(lineBuffer);
                    }
                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Copilot OpenAI stream error (fallback):', err);
                    res.end();
                });

                res.on('close', () => {
                    if (response.body && !response.body.destroyed) {
                        response.body.destroy();
                    }
                });
            } else {
                const responseBody = await readBody(response.body);
                let parsed;
                try {
                    parsed = JSON.parse(responseBody);
                } catch {
                    sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                    return;
                }
                const inputTokens = parsed.usage?.prompt_tokens || 0;
                const outputTokens = parsed.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(parsed.usage);
                copilotStore.incrementApiCallCount();
                if (inputTokens > 0 || outputTokens > 0) {
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                } else {
                    const estimated = estimateMessageTokens(openAIPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                sendJson(res, 200, parsed);
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Anthropic 模式 ==================== */

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

        logger.info(`Copilot Anthropic request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

        const conversationKey = extractConversationKey(req, anthropicPayload);

        const responsesReq = anthropicToResponses(anthropicPayload);

        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const responsesToAnthropicBridge = createResponsesToAnthropicStreamBridge({model: anthropicPayload.model});
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const anthropicEvents = responsesToAnthropicBridge.feed(event.type, event.data);
                        for (const ev of anthropicEvents) {
                            if (res.destroyed) break;
                            res.write(`event: ${ev.type}\n`);
                            res.write(`data: ${JSON.stringify(ev)}\n\n`);
                        }
                    }
                    if (!responsesToAnthropicBridge.finished) {
                        for (const ev of responsesToAnthropicBridge.finish()) {
                            if (res.destroyed) break;
                            res.write(`event: ${ev.type}\n`);
                            res.write(`data: ${JSON.stringify(ev)}\n\n`);
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (streamInputTokens > 0 || streamOutputTokens > 0) {
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                } else {
                    copilotStore.incrementApiCallCount();
                    const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                if (!res.destroyed) res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const chatResponse = responsesResponseToChat(completedData.response);
                    const anthropicResponse = openAIToAnthropic(chatResponse);
                    const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                    const outputTokens = chatResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                    copilotStore.incrementApiCallCount();
                    if (inputTokens > 0 || outputTokens > 0) {
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                    } else {
                        const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    sendJson(res, 200, anthropicResponse);
                } else {
                    sendAnthropicError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (res.headersSent) {
                logger.warn(`Copilot Anthropic: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot Anthropic: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const openAIPayload = anthropicToOpenAI(anthropicPayload);
            const response = await createChatCompletions(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                openAIPayload,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendAnthropicError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatToAnthropicBridge = createChatToAnthropicStreamBridge({model: anthropicPayload.model});
                let buffer = '';
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                const processLines = (lines) => {
                    for (const line of lines) {
                        if (res.destroyed) return;

                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.slice(6);

                            if (data === '[DONE]') {
                                continue;
                            }

                            try {
                                const openAIChunk = JSON.parse(data);
                                const anthropicEvents = chatToAnthropicBridge.feed(openAIChunk);

                                if (openAIChunk.usage) {
                                    streamInputTokens = openAIChunk.usage.prompt_tokens || streamInputTokens;
                                    streamOutputTokens = openAIChunk.usage.completion_tokens || streamOutputTokens;
                                    streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage);
                                }

                                for (const event of anthropicEvents) {
                                    if (res.destroyed) return;
                                    res.write(`event: ${event.type}\n`);
                                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                                }
                            } catch (e) {
                                logger.error('Failed to parse chunk:', e);
                            }
                        }
                    }
                };

                response.body.on('data', (chunk) => {
                    try {
                        if (res.destroyed) return;

                        buffer += chunk.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        processLines(lines);
                    } catch (error) {
                        logger.error('Stream processing error:', error);
                    }
                });

                response.body.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            processLines([buffer]);
                        } catch (error) {
                            logger.error('Failed to process remaining buffer:', error);
                        }
                        buffer = '';
                    }
                    if (!chatToAnthropicBridge.finished) {
                        for (const event of chatToAnthropicBridge.finish()) {
                            if (res.destroyed) return;
                            res.write(`event: ${event.type}\n`);
                            res.write(`data: ${JSON.stringify(event)}\n\n`);
                        }
                    }
                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(openAIPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    if (!res.destroyed) {
                        res.end();
                    }
                });

                response.body.on('error', (error) => {
                    logger.error('Stream error (fallback):', error);
                    if (!res.destroyed) {
                        res.end();
                    }
                });

                res.on('close', () => {
                    if (response.body && !response.body.destroyed) {
                        response.body.destroy();
                    }
                });
            } else {
                const responseBody = await readBody(response.body);
                const openAIResponse = JSON.parse(responseBody);
                const anthropicResponse = openAIToAnthropic(openAIResponse);
                const inputTokens = openAIResponse.usage?.prompt_tokens || 0;
                const outputTokens = openAIResponse.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(openAIResponse.usage);
                copilotStore.incrementApiCallCount();
                if (inputTokens > 0 || outputTokens > 0) {
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                } else {
                    const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                    copilotStore.incrementTokenUsage(estimated, 0, 0);
                    copilotStore.recordDailyUsage(estimated, 0, 0);
                }
                sendJson(res, 200, anthropicResponse);
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses API 模式 ==================== */

/**
 * 处理 OpenAI Responses API 请求 (/copilot/v1/responses)
 */
async function handleResponsesAPI(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        logger.info(`Copilot Responses request - model: ${responsesReq.model}, stream: ${responsesReq.stream}`);

        const conversationKey = extractConversationKey(req, responsesReq);

        // 净化 input：去除上游 WS 无法解析的 id 引用（Codex 续接对话时带入的 output item id）
        if (Array.isArray(responsesReq.input)) {
            responsesReq.input = sanitizeResponsesInput(responsesReq.input, responsesReq.model);
        }

        // WS 通道：直接发送 Responses 格式
        try {
            ensureResponsesWebSocketSupported(responsesReq.model);
            const wsResult = await createResponsesWS(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                responsesReq,
                copilotState.accountType,
                proxyUrl,
                {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
            );

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const responsesToResponsesBridge = createResponsesToResponsesStreamBridge({model: responsesReq.model});
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed' && event.data?.response?.usage) {
                            const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                            streamInputTokens = chatUsage.prompt_tokens || 0;
                            streamOutputTokens = chatUsage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                        }
                        const responseEvents = responsesToResponsesBridge.feed(event.type, event.data);
                        for (const ev of responseEvents) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    if (!responsesToResponsesBridge.finished) {
                        for (const ev of responsesToResponsesBridge.finish()) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                res.end();
            } else {
                let completedData = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            completedData = event.data;
                        }
                    }
                    releaseWSConnection(wsResult.conn);
                } catch (err) {
                    discardWSConnection(wsResult.conn);
                    throw err;
                }

                if (completedData?.response) {
                    const usage = completedData.response.usage || {};
                    const chatUsage = convertResponsesUsageToChat(usage);
                    const inputTokens = chatUsage.prompt_tokens || 0;
                    const outputTokens = chatUsage.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(chatUsage);
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                    copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                    sendJson(res, 200, completedData.response);
                } else {
                    sendOpenAIError(res, 502, 'No response.completed event received from upstream');
                }
            }
        } catch (wsError) {
            if (isResponsesProtocolError(wsError)) {
                logger.warn(`Copilot Responses: WS protocol error: ${wsError.message}`);
                sendResponsesProtocolError(res, wsError);
                return;
            }

            if (res.headersSent) {
                logger.warn(`Copilot Responses: WS stream failed after response started: ${wsError.message}`);
                if (!res.destroyed && !res.writableEnded) {
                    res.end();
                }
                return;
            }

            logger.warn(`Copilot Responses: WS failed, falling back to HTTP POST: ${wsError.message}`);

            const chatReq = responsesRequestToChat(responsesReq);
            const response = await createChatCompletions(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                chatReq,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
                let buffer = Buffer.alloc(0);
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;

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
                        }
                        const events = chatToResponsesBridge.feed(data);
                        for (const ev of events) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                });

                response.body.on('end', () => {
                    if (!chatToResponsesBridge.finished) {
                        for (const ev of chatToResponsesBridge.finish()) {
                            res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                        }
                    }
                    copilotStore.incrementApiCallCount();
                    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Responses stream error (fallback):', err);
                    res.end();
                });
            } else {
                const responseBody = await readBody(response.body);
                const chatResponse = JSON.parse(responseBody);

                const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                const outputTokens = chatResponse.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                copilotStore.incrementApiCallCount();
                copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);

                sendJson(res, 200, chatResponseToResponses(chatResponse));
            }
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses Compact API ==================== */

/**
 * 处理 OpenAI Responses Compact 请求 (/copilot/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const networkOptions = getCopilotNetworkOptions(req);
        const proxyUrl = networkOptions.proxyUrl;
        const authResult = await ensureCopilotAuth(networkOptions);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        // Compact -> Chat Completions
        const chatReq = compactRequestToChat(compactReq);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            chatReq,
            copilotState.accountType,
            proxyUrl,
            networkOptions
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        const responseBody = await readBody(response.body);
        const chatResponse = JSON.parse(responseBody);

        const inputTokens = chatResponse.usage?.prompt_tokens || 0;
        const outputTokens = chatResponse.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
        copilotStore.incrementApiCallCount();
        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Copilot: Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 Copilot Responses API WebSocket 连接
 * 客户端通过 WS 连接 /copilot/v1/responses，发送标准 Responses API WS 协议
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {http.IncomingMessage} req - 原始 HTTP 请求
 */
function handleCopilotResponsesWSInContext(clientWs, req) {
    const tenantContext = currentCopilotContext();
    handleWSConnection(clientWs, {
        authenticate: () => true,
        runInContext: callback => runWithCopilotContext(tenantContext, callback),
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            // Copilot 认证
            if (!isAuthenticated()) {
                throw Object.assign(new Error('Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.'), {
                    name: 'ResponsesWSError',
                    event: {type: 'error', error: {message: 'Not authenticated', code: 'unauthorized'}}
                });
            }

            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;

            try {
                const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
                const conversationKey = extractConversationKey(req, payload);

                // 净化 input
                if (Array.isArray(payload.input)) {
                    payload = {...payload, input: sanitizeResponsesInput(payload.input, payload.model)};
                }

                // 尝试 WS 模式（GPT 系列模型）
                if (supportsResponsesWebSocket(payload.model)) {
                    try {
                        const wsResult = await createResponsesWS(
                            copilotToken,
                            copilotState.vsCodeVersion,
                            payload,
                            copilotState.accountType,
                            proxyUrl,
                            {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                        );

                        const eventStream = wsResult.eventStream;
                        const conn = wsResult.conn;

                        // 注意：必须用 finally 释放连接
                        // 否则 WS server 在收到 response.completed 后 break，会触发 generator return()，
                        // try 块尾部的 releaseWSConnection 永远到不了，连接将一直 busy 烂在池里
                        let connHandled = false;
                        try {
                            for await (const event of eventStream) {
                                if (signal?.aborted) {
                                    discardWSConnection(conn);
                                    connHandled = true;
                                    return;
                                }
                                yield event;
                            }
                        } catch (err) {
                            discardWSConnection(conn);
                            connHandled = true;
                            throw err;
                        } finally {
                            if (!connHandled) releaseWSConnection(conn);
                        }
                        return;
                    } catch (wsError) {
                        logger.warn(`Copilot WS: WS failed, falling back to HTTP: ${wsError.message}`);
                    }
                }

                // HTTP 回退：Responses → Chat Completions → Responses 事件转换
                const chatReq = responsesRequestToChat(payload);
                chatReq.stream = true;

                const response = await createChatCompletions(
                    copilotToken,
                    copilotState.vsCodeVersion,
                    chatReq,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    throw Object.assign(new Error(`Upstream error: ${errorBody.slice(0, 500)}`), {
                        name: 'ResponsesWSError',
                        event: {type: 'error', error: {message: `Upstream error: ${response.status}`, code: 'upstream_error'}}
                    });
                }

                // 将 Chat SSE 流转换为 Responses WS 事件
                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
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

                        const events = chatToResponsesBridge.feed(data);
                        for (const ev of events) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                }

                if (!chatToResponsesBridge.finished) {
                    for (const ev of chatToResponsesBridge.finish()) {
                        yield {type: ev.event, data: ev.data};
                    }
                }
            } catch (error) {
                logger.error('Copilot WS: handleRequest error:', error);
                throw error;
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/* ==================== 根路径 ==================== */

function handleRoot(req, res) {
    sendJson(res, 200, {
        name: 'GitHub Copilot API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic', 'responses'],
        authenticated: isAuthenticated(),
        user: copilotState.userInfo,
        endpoints: {
            openai: {
                chatCompletions: 'POST /copilot/v1/chat/completions - OpenAI format',
                responses: 'POST /copilot/v1/responses - OpenAI Responses API',
                responsesCompact: 'POST /copilot/v1/responses/compact - Responses Compact API',
                models: 'GET /copilot/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /copilot/anthropic/v1/messages - Claude format',
                countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                models: 'GET /copilot/anthropic/v1/models - Claude format models'
            }
        },
        configuration: {
            tokenSource: isAuthenticated() ? 'tenant credential database' : 'not configured'
        }
    });
}

/* ==================== 主路由 ==================== */

async function routeCopilotRequestInContext(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    logger.info(`Copilot request: ${method} ${pathname}`);

    // ========== Anthropic 模式 ==========
    if (pathname.startsWith('/copilot/anthropic')) {
        const anthropicPath = pathname.replace('/copilot/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Copilot API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /copilot/anthropic/v1/messages',
                    countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                    models: 'GET /copilot/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式 ==========
    if (pathname === '/copilot/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/copilot/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/copilot/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/copilot/v1/models' && method === 'GET') {
        return handleOpenAIModels(req, res);
    }

    // ========== 根路径 ==========
    if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}

export async function routeCopilotRequest(req, res) {
    try {
        return await runCopilotTenantContext(
            req.tenantId,
            () => routeCopilotRequestInContext(req, res)
        );
    } catch (error) {
        logger.error(`Copilot tenant context failed: ${error.message}`);
        sendOpenAIError(res, 503, error.message);
    }
}

export async function handleCopilotResponsesWS(clientWs, req) {
    try {
        return await runCopilotTenantContext(
            req.tenantId,
            () => handleCopilotResponsesWSInContext(clientWs, req)
        );
    } catch (error) {
        logger.error(`Copilot WebSocket tenant context failed: ${error.message}`);
        clientWs.close(1011, error.message.slice(0, 120));
    }
}
