/**
 * Relay 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/relay
 */

import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {
    createChatCompletions,
    createResponses,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createAnthropicMessages,
    createAnthropicCountTokens,
    getUpstreamModels,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    normalizeUpstreamProtocol,
    RelayUpstreamError
} from '../services/relay/api.js';
import {readBody, isNetworkError} from '../utils/http-client.js';
import {sampleRequest} from '../services/coach/sampler.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic,
    ClaudeStreamState,
    SSEWriter,
    injectBehaviorRules,
    mapStopReason
} from '../services/relay/translator.js';
import {
    rewriteOpenAIStream,
    stripDynamicReminders,
    buildConversationAnchorKey,
    sanitizeAnthropicPayload
} from '../transformer/shared-translator.js';
import {
    responsesRequestToChat,
    chatRequestToResponses,
    chatResponseToResponses,
    responsesResponseToChat,
    createResponsesStreamState,
    createChatCompletionsStreamState,
    chatChunkToResponsesEvents,
    responsesEventToChatChunks,
    responsesEventToResponsesEvents,
    compactRequestToChat,
    chatResponseToCompact
} from '../transformer/responses-translator.js';
import {isResponsesWebSocketProtocolError} from '../services/shared/responses-ws-client.js';
import {handleWSConnection} from '../services/shared/responses-ws-server.js';
import {
    createStreamState as createAnthropicEventState,
    translateStreamChunk as chatChunkToAnthropicEvents
} from '../services/copilot/anthropic-translator.js';
import {
    anthropicResponseToChat,
    anthropicStreamToChatChunks,
    chatRequestToAnthropic
} from './relay-protocol-converters.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import {estimateMessageTokens} from '../utils/token-estimation.js';
import logger from '../utils/logger.js';

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

function normalizeConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.conversation_id,
        payload.conversationId,
        payload.session_id,
        payload.sessionId,
        payload.thread_id,
        payload.threadId,
        metadata?.conversation_id,
        metadata?.conversationId,
        metadata?.session_id,
        metadata?.sessionId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeConversationKey(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

function extractConversationKey(req, payload, meta = {}) {
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeConversationKey(value);
        if (normalized) return normalized;
    }

    const payloadResult = extractConversationKeyFromPayload(payload);
    if (payloadResult) return payloadResult;

    // Fallback: 用共享的 buildConversationAnchorKey，只基于第一条 user + tenantId
    const anchorPayload = payload && typeof payload === 'object'
        ? {...payload, messages: payload?.messages || payload?.input}
        : {messages: payload?.messages || payload?.input};
    return buildConversationAnchorKey(anchorPayload, meta);
}

function sendResponsesWebSocketProtocolError(res, error) {
    const event = error?.event || {
        type: 'error',
        status: error?.status || 400,
        error: {message: error?.message || 'Responses WebSocket request failed'}
    };

    if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        }
        return;
    }

    sendJson(res, event.status || error?.status || 400, event);
}

async function collectResponsesWebSocketResponse(wsResult) {
    let completedData = null;
    try {
        for await (const event of wsResult.eventStream) {
            if (event.type === 'response.completed') {
                completedData = event.data;
            }
        }
        releaseResponsesWebSocketConnection(wsResult.conn);
    } catch (error) {
        discardResponsesWebSocketConnection(wsResult.conn);
        throw error;
    }

    if (!completedData?.response) {
        throw new Error('No response.completed event received from upstream');
    }
    return completedData.response;
}

function recordResponsesUsage(tenantId, usage, model) {
    recordUsage(
        tenantId,
        usage?.input_tokens || 0,
        usage?.output_tokens || 0,
        usage?.input_tokens_details?.cached_tokens || 0,
        model
    );
}

function upstreamErrorStatus(err) {
    if (err instanceof RelayUpstreamError && err.status) return err.status;
    if (isNetworkError(err)) return 502;
    return 500;
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

function extractAnthropicCacheHitTokens(usage) {
    if (!usage) return 0;
    return usage.cache_read_input_tokens || 0;
}

function parseSSEBlock(block) {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }

    return {event, data: dataLines.join('\n')};
}

async function* parseResponsesSSEEvents(stream, signal) {
    let buffer = '';
    for await (const chunk of stream) {
        if (signal?.aborted) break;
        buffer += chunk.toString('utf8');
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';

        for (const part of parts) {
            const {event, data} = parseSSEBlock(part);
            if (!data || data === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }
            yield {type: event || parsed.type, data: parsed};
        }
    }
}

function writeAnthropicEvent(res, event) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function streamResponsesEventsAsAnthropic(eventStream, res, signal) {
    const chatState = createChatCompletionsStreamState();
    const anthropicState = createAnthropicEventState();
    let usage = null;

    for await (const event of eventStream) {
        if (signal?.aborted) break;
        if (event.type === 'response.completed') {
            usage = event.data?.response?.usage || usage;
        }
        const chatChunks = responsesEventToChatChunks(event.type, event.data, chatState);
        for (const chatChunk of chatChunks) {
            const anthropicEvents = chatChunkToAnthropicEvents(chatChunk, anthropicState);
            for (const anthropicEvent of anthropicEvents) {
                writeAnthropicEvent(res, anthropicEvent);
            }
        }
    }

    return usage;
}

function handleAnthropicUsageEvent(eventName, payload, usageState) {
    const usage = payload?.usage || payload?.message?.usage;
    if (!usage) return;

    if (usage.input_tokens !== undefined) usageState.inputTokens = usage.input_tokens;
    if (usage.output_tokens !== undefined) usageState.outputTokens = usage.output_tokens;
    usageState.cacheHitTokens = Math.max(usageState.cacheHitTokens, extractAnthropicCacheHitTokens(usage));
    if (eventName === 'message_start' && payload?.message?.model) usageState.model = payload.message.model;
}

function estimateAnthropicInputTokens(payload) {
    const messages = [];
    if (typeof payload.system === 'string') {
        messages.push({role: 'system', content: payload.system});
    } else if (Array.isArray(payload.system)) {
        messages.push({role: 'system', content: payload.system});
    }
    messages.push(...(payload.messages || []));
    const messageTokens = estimateMessageTokens(messages);
    const toolTokens = Array.isArray(payload.tools)
        ? estimateMessageTokens(payload.tools.map((tool) => ({role: 'tool', content: JSON.stringify(tool)})))
        : 0;
    return messageTokens + toolTokens;
}

function mapAnthropicModelsToOpenAI(modelsData) {
    const items = Array.isArray(modelsData?.data) ? modelsData.data : [];
    return {
        object: 'list',
        data: items.map((model) => ({
            id: model.id,
            object: 'model',
            created: model.created_at ? Math.floor(new Date(model.created_at).getTime() / 1000) : 0,
            owned_by: model.display_name || model.type || 'anthropic'
        }))
    };
}

function mapOpenAIModelsToAnthropic(modelsData) {
    return {
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
}

function getAnthropicRequestHeaders(req) {
    return {
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        ...(req.headers['anthropic-beta'] ? {'anthropic-beta': req.headers['anthropic-beta']} : {})
    };
}

function getProtocolErrorMessage(upstream, expectedProtocol, endpoint) {
    const protocol = normalizeUpstreamProtocol(upstream?.protocol);
    if (protocol === expectedProtocol) return null;
    if (expectedProtocol === 'anthropic') {
        return `当前上游协议为 ${protocol}，请改用 ${endpoint} 或切换上游类型`;
    }
    return `当前上游协议为 ${protocol}，该端点需要 ${expectedProtocol} 上游支持`;
}

/* ==================== 鉴权 ==================== */

async function authenticateAndGetUpstream(req) {
    // req.tenantId is already set by requireApiAuth in server.js
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'Relay tenant system is not enabled'}};
    }

    const upstreamManager = await unifiedTenantManager.getUpstreamManager(tenantId);
    if (!upstreamManager) {
        return {error: {status: 503, message: 'Tenant upstream manager not found'}};
    }

    const upstream = upstreamManager.getActiveUpstream();
    if (!upstream) {
        return {error: {status: 503, message: '未配置可用上游，请在管理面板 /admin 配置'}};
    }

    return {upstream, tenantId, upstreamManager};
}

/**
 * 调用上游，失败直接抛错
 */
async function callUpstream(upstream, fn) {
    const response = await fn(upstream);
    if (response.status >= 200 && response.status < 300) {
        return {response, upstream};
    }
    const errorBody = await readBody(response.body);
    throw new Error(`上游「${upstream.name}」返回 HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
}

function recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown', samplePayload = null, sampleResponse = null) {
    if (!tenantId) return;
    unifiedTenantManager.incrementApiCallCount(tenantId, 'relay');
    unifiedTenantManager.incrementTokenUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens);
    unifiedTenantManager.recordDailyUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens, 0, model);
    if (samplePayload) {
        sampleRequest(tenantId, 'relay', samplePayload, sampleResponse, model).catch(() => {});
    }
}

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式的 /relay/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    let tenantInfo = '';
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (!authResult.error) {
            const tenant = await unifiedTenantManager.getTenant(authResult.tenantId);
            if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
        }
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const {upstream, tenantId, upstreamManager} = authResult;
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
        // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
        openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);

        if (isAnthropicUpstream(upstream)) {
            const anthropicPayload = chatRequestToAnthropic({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index)
            });
            const {response} = await callUpstream(upstream, (up) =>
                createAnthropicMessages(
                    anthropicPayload,
                    up,
                    {
                        requestType: 'ChatCompletionsViaAnthropic',
                        stream: openAIPayload.stream,
                        originalModel: openAIPayload.model,
                        ...tenantMeta
                    },
                    getAnthropicRequestHeaders(req)
                )
            );

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });
                let finalUsage = null;
                for await (const chatChunk of anthropicStreamToChatChunks(response.body, parseSSEBlock)) {
                    if (chatChunk.usage) finalUsage = chatChunk.usage;
                    res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                }
                recordUsage(
                    tenantId,
                    finalUsage?.prompt_tokens || 0,
                    finalUsage?.completion_tokens || 0,
                    finalUsage?.prompt_tokens_details?.cached_tokens || 0,
                    openAIPayload.model
                );
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            const chatResponse = anthropicResponseToChat(parsed, openAIPayload.model);
            const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
            recordUsage(
                tenantId,
                chatResponse.usage?.prompt_tokens || 0,
                chatResponse.usage?.completion_tokens || 0,
                cacheHitTokens,
                openAIPayload.model
            );
            sampleRequest(tenantId, 'relay', openAIPayload, parsed, openAIPayload.model).catch(() => {});
            sendJson(res, 200, chatResponse);
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const responsesPayload = chatRequestToResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index)
            });
            const wsResult = await createResponsesWebSocket(responsesPayload, upstream, {
                requestType: 'ChatCompletionsViaResponsesWS',
                stream: openAIPayload.stream,
                originalModel: openAIPayload.model,
                contextKey: extractConversationKey(req, responsesPayload, {tenantId}),
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const streamState = createChatCompletionsStreamState();
                let usage = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            usage = event.data?.response?.usage || usage;
                        }
                        const chunks = responsesEventToChatChunks(event.type, event.data, streamState);
                        for (const chatChunk of chunks) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }
                    }
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                recordResponsesUsage(tenantId, usage, openAIPayload.model);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordResponsesUsage(tenantId, completedResponse.usage, openAIPayload.model);
            sendJson(res, 200, responsesResponseToChat(completedResponse));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = chatRequestToResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index)
            });

            const conversationKey = extractConversationKey(req, responsesPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(responsesPayload, up, {
                    requestType: 'ChatCompletionsViaResponses',
                    stream: openAIPayload.stream,
                    originalModel: openAIPayload.model,
                    ...relayMeta
                })
            );

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const streamState = createChatCompletionsStreamState();
                let buffer = '';
                let usage = null;

                response.body.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (!data || data === '[DONE]') continue;
                        let parsed;
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            continue;
                        }

                        if (event === 'response.created' && parsed.response?.model) {
                            streamState.model = parsed.response.model;
                        }

                        if (event === 'response.completed') {
                            usage = parsed.response?.usage || usage;
                        }

                        const chunks = responsesEventToChatChunks(event, parsed, streamState);
                        for (const chatChunk of chunks) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }

                        if (event === 'response.completed') {
                            recordUsage(
                                tenantId,
                                usage?.input_tokens || 0,
                                usage?.output_tokens || 0,
                                usage?.input_tokens_details?.cached_tokens || 0,
                                openAIPayload.model
                            );
                            res.write('data: [DONE]\n\n');
                        }
                    }
                });

                response.body.on('end', () => {
                    if (!streamState.completed) {
                        res.write(`data: ${JSON.stringify({
                            id: streamState.chatId,
                            object: 'chat.completion.chunk',
                            created: streamState.created,
                            model: streamState.model,
                            choices: [{index: 0, delta: {}, finish_reason: streamState.sawToolCall ? 'tool_calls' : 'stop'}]
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                    }
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error(`Relay Responses->Chat stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                logger.error('Relay: failed to parse responses upstream non-stream response');
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }

            recordUsage(
                tenantId,
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                openAIPayload.model
            );
            sampleRequest(tenantId, 'relay', openAIPayload, parsed, openAIPayload.model).catch(() => {});
            sendJson(res, 200, responsesResponseToChat(parsed));
            return;
        }

        const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: tenantId ? `session-${tenantId}` : conversationKey
        };
        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...openAIPayload, model: upstreamManager.resolveModel(openAIPayload.model, up.index)};
            return createChatCompletions(payload, up, relayMeta);
        });

        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });
            _streamOpenAIPassthrough(response, res, tenantId, tenantInfo, openAIPayload.model);
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
            const cacheHitTokens = extractCacheHitTokens(parsed.usage);
            recordUsage(
                tenantId,
                parsed.usage?.prompt_tokens || 0,
                parsed.usage?.completion_tokens || 0,
                cacheHitTokens,
                openAIPayload.model
            );
            sampleRequest(tenantId, 'relay', openAIPayload, parsed, openAIPayload.model).catch(() => {});
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        if (isResponsesWebSocketProtocolError(error)) {
            sendResponsesWebSocketProtocolError(res, error);
            return;
        }
        if (res.headersSent) {
            logger.warn(`Relay Responses WS stream failed after response started: ${error.message}`);
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
        }
        logger.error(`Relay: Failed to handle OpenAI chat completions${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /relay/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    let tenantInfo = '';
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (!authResult.error) {
            const tenant = await unifiedTenantManager.getTenant(authResult.tenantId);
            if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
        }
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, tenantId, upstreamManager} = authResult;
        const body = await parseBody(req);
        const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        if (isAnthropicUpstream(upstream)) {
            const {response} = await callUpstream(upstream, (up) =>
                createAnthropicMessages(
                    {...anthropicPayload, model: upstreamManager.resolveModel(anthropicPayload.model, up.index)},
                    up,
                    {
                        requestType: 'AnthropicPassthrough',
                        stream: anthropicPayload.stream,
                        originalModel: anthropicPayload.model,
                        ...tenantMeta
                    },
                    getAnthropicRequestHeaders(req)
                )
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const usageState = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheHitTokens: 0,
                    model: anthropicPayload.model
                };
                let buffer = '';

                response.body.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    res.write(text);
                    buffer += text;
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (!data || data === '[DONE]') continue;
                        try {
                            handleAnthropicUsageEvent(event, JSON.parse(data), usageState);
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    recordUsage(
                        tenantId,
                        usageState.inputTokens || estimateAnthropicInputTokens(anthropicPayload),
                        usageState.outputTokens,
                        usageState.cacheHitTokens,
                        usageState.model || anthropicPayload.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error(`Relay Anthropic passthrough stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                sendAnthropicError(res, 502, 'Upstream returned invalid JSON');
                return;
            }

            recordUsage(
                tenantId,
                parsed.usage?.input_tokens || estimateAnthropicInputTokens(anthropicPayload),
                parsed.usage?.output_tokens || 0,
                extractAnthropicCacheHitTokens(parsed.usage),
                parsed.model || anthropicPayload.model
            );
            sampleRequest(tenantId, 'relay', anthropicPayload, parsed, parsed.model || anthropicPayload.model).catch(() => {});
            sendJson(res, 200, parsed);
            return;
        }

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages);
        openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);

        if (isResponsesWebSocketUpstream(upstream)) {
            const responsesPayload = chatRequestToResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index),
                stream: anthropicPayload.stream
            });
            const wsResult = await createResponsesWebSocket(responsesPayload, upstream, {
                requestType: 'AnthropicViaResponsesWebSocket',
                stream: anthropicPayload.stream,
                originalModel: anthropicPayload.model,
                contextKey: extractConversationKey(req, responsesPayload, {tenantId}),
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                let usage = null;
                try {
                    usage = await streamResponsesEventsAsAnthropic(wsResult.eventStream, res, req.signal);
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                recordResponsesUsage(tenantId, usage, anthropicPayload.model);
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordResponsesUsage(tenantId, completedResponse.usage, anthropicPayload.model);
            const chatResponse = responsesResponseToChat(completedResponse);
            sampleRequest(tenantId, 'relay', anthropicPayload, completedResponse, anthropicPayload.model).catch(() => {});
            sendJson(res, 200, openAIToAnthropic(chatResponse));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = chatRequestToResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index),
                stream: anthropicPayload.stream
            });
            const conversationKey = extractConversationKey(req, responsesPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(responsesPayload, up, {
                    requestType: 'AnthropicViaResponses',
                    stream: anthropicPayload.stream,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                })
            );

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const usage = await streamResponsesEventsAsAnthropic(parseResponsesSSEEvents(response.body, req.signal), res, req.signal);
                recordResponsesUsage(tenantId, usage, anthropicPayload.model);
                res.end();
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordResponsesUsage(tenantId, parsed.usage, anthropicPayload.model);
            const chatResponse = responsesResponseToChat(parsed);
            sampleRequest(tenantId, 'relay', anthropicPayload, parsed, anthropicPayload.model).catch(() => {});
            sendJson(res, 200, openAIToAnthropic(chatResponse));
            return;
        }

        if (anthropicPayload.stream) {
            // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
            const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) => {
                const payload = {
                    ...openAIPayload,
                    model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                };
                return createChatCompletions(payload, up, {
                    requestType: 'Anthropic',
                    stream: anthropicPayload.stream,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                });
            });

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
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
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
                recordUsage(tenantId, streamInputTokens, streamOutputTokens, streamCacheHitTokens, anthropicPayload.model);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error(`Relay Anthropic stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                state.emitErrorText('模型请求异常，请稍后重试。\n' + (err?.message || ''));
                state.finalStopReason = 'error';
                state.endMessage('error');
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，用 aggregateStreamResponse 聚合
            openAIPayload.stream = true;
            // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
            const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) => {
                const payload = {
                    ...openAIPayload,
                    model: upstreamManager.resolveModel(openAIPayload.model, up.index)
                };
                return createChatCompletions(payload, up, {
                    requestType: 'Anthropic',
                    stream: false,
                    originalModel: anthropicPayload.model,
                    ...relayMeta
                });
            });

            const aggregated = await aggregateStreamResponse(response.body);
            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, anthropicPayload.model);
            sampleRequest(tenantId, 'relay', anthropicPayload, aggregated, anthropicPayload.model).catch(() => {});

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
        logger.error(`Relay: Failed to handle Anthropic messages${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 → OpenAI 上游），对 reasoning_content 做缓冲合并 */
function _streamOpenAIPassthrough(response, res, tenantId, tenantInfo = '', model = 'unknown') {
    rewriteOpenAIStream(res, response.body, (inputTokens, outputTokens, cacheHitTokens) => {
        recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, model);
    });
}

/* ==================== 其他端点 ==================== */

async function handleOpenAIModels(req, res) {
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
        sendJson(res, 200, isAnthropicUpstream(authResult.upstream) ? mapAnthropicModelsToOpenAI(modelsData) : modelsData);
    } catch (error) {
        logger.error('Relay: Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

async function handleAnthropicModels(req, res) {
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const modelsData = await getUpstreamModels(authResult.upstream, getAnthropicRequestHeaders(req));
        sendJson(res, 200, isAnthropicUpstream(authResult.upstream) ? modelsData : mapOpenAIModelsToAnthropic(modelsData));
    } catch (error) {
        logger.error('Relay: Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }
        const body = await parseBody(req);
        const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

        if (isAnthropicUpstream(authResult.upstream)) {
            const {response} = await callUpstream(authResult.upstream, (up) =>
                createAnthropicCountTokens(anthropicPayload, up, getAnthropicRequestHeaders(req))
            );
            const responseBody = await readResponseBody(response.body);
            sendJson(res, 200, JSON.parse(responseBody));
            return;
        }

        if (isResponsesUpstream(authResult.upstream) || isResponsesWebSocketUpstream(authResult.upstream)) {
            sendAnthropicError(res, 400, getProtocolErrorMessage(authResult.upstream, 'anthropic', '/relay/v1/responses'));
            return;
        }

        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);
        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Relay: Failed to count tokens:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== Responses API ==================== */

/**
 * 处理 Responses API 请求 (/relay/v1/responses)
 * 将 Responses 格式转为 Chat Completions 发给上游，再将响应转回 Responses 格式
 */
async function handleResponsesAPI(req, res) {
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, tenantId, upstreamManager} = authResult;
        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);

        if (isAnthropicUpstream(upstream)) {
            const chatReq = responsesRequestToChat(responsesReq);
            chatReq.messages = injectBehaviorRules(chatReq.messages);
            chatReq.messages = stripDynamicReminders(chatReq.messages);
            chatReq.stream = responsesReq.stream;
            const anthropicPayload = chatRequestToAnthropic({
                ...chatReq,
                model: upstreamManager.resolveModel(chatReq.model, upstream.index),
                stream: responsesReq.stream
            });
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const {response} = await callUpstream(upstream, (up) =>
                createAnthropicMessages(
                    anthropicPayload,
                    up,
                    {
                        requestType: 'ResponsesViaAnthropic',
                        stream: responsesReq.stream,
                        originalModel: responsesReq.model,
                        ...tenantMeta
                    },
                    getAnthropicRequestHeaders(req)
                )
            );

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const streamState = createResponsesStreamState();
                let finalUsage = null;
                for await (const chatChunk of anthropicStreamToChatChunks(response.body, parseSSEBlock, req.signal)) {
                    if (chatChunk.usage) finalUsage = chatChunk.usage;
                    const events = chatChunkToResponsesEvents(chatChunk, streamState);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                recordUsage(
                    tenantId,
                    finalUsage?.prompt_tokens || 0,
                    finalUsage?.completion_tokens || 0,
                    finalUsage?.prompt_tokens_details?.cached_tokens || 0,
                    responsesReq.model
                );
                res.end();
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            const chatResponse = anthropicResponseToChat(parsed, responsesReq.model);
            recordUsage(
                tenantId,
                chatResponse.usage?.prompt_tokens || 0,
                chatResponse.usage?.completion_tokens || 0,
                chatResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
                responsesReq.model
            );
            sampleRequest(tenantId, 'relay', responsesReq, parsed, responsesReq.model).catch(() => {});
            sendJson(res, 200, chatResponseToResponses(chatResponse));
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const wsPayload = {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, upstream.index)};
            const wsResult = await createResponsesWebSocket(wsPayload, upstream, {
                requestType: 'ResponsesWebSocket',
                stream: responsesReq.stream,
                originalModel: responsesReq.model,
                contextKey: extractConversationKey(req, wsPayload, {tenantId}),
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatState = createChatCompletionsStreamState();
                const responsesState = createResponsesStreamState();
                let usage = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            usage = event.data?.response?.usage || usage;
                        }
                        const responseEvents = responsesEventToResponsesEvents(event.type, event.data, chatState, responsesState);
                        for (const responseEvent of responseEvents) {
                            res.write(`event: ${responseEvent.event}\ndata: ${JSON.stringify(responseEvent.data)}\n\n`);
                        }
                    }
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                recordResponsesUsage(tenantId, usage, responsesReq.model);
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordResponsesUsage(tenantId, completedResponse.usage, responsesReq.model);
            sendJson(res, 200, completedResponse);
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(
                    {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, up.index)},
                    up,
                    {
                        requestType: 'ResponsesPassthrough',
                        stream: responsesReq.stream,
                        originalModel: responsesReq.model,
                        ...relayMeta
                    }
                )
            );

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                let usage = null;
                let buffer = '';
                response.body.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    res.write(text);
                    buffer += text;
                    const parts = buffer.split(/\r?\n\r?\n/);
                    buffer = parts.pop() || '';

                    for (const part of parts) {
                        const {event, data} = parseSSEBlock(part);
                        if (event !== 'response.completed' || !data || data === '[DONE]') continue;
                        try {
                            usage = JSON.parse(data).response?.usage || usage;
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    recordUsage(
                        tenantId,
                        usage?.input_tokens || 0,
                        usage?.output_tokens || 0,
                        usage?.input_tokens_details?.cached_tokens || 0,
                        responsesReq.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error('Relay Responses passthrough stream error:', err);
                    res.end();
                });
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordUsage(
                tenantId,
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                responsesReq.model
            );
            sendJson(res, 200, parsed);
            return;
        }

        // Responses → Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);
        chatReq.messages = injectBehaviorRules(chatReq.messages);
        // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
        chatReq.messages = stripDynamicReminders(chatReq.messages);

        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
        const conversationKey = extractConversationKey(req, chatReq, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: tenantId ? `session-${tenantId}` : conversationKey
        };

        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index)};
            return createChatCompletions(payload, up, {
                requestType: 'Responses',
                stream: responsesReq.stream,
                originalModel: responsesReq.model,
                ...relayMeta
            });
        });

        if (responsesReq.stream) {
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
                if (!streamState.started || !streamState.finished) {
                    if (streamState.reasoningOpen) {
                        const item = {type: 'reasoning', id: streamState.reasoningItemId, status: 'completed', summary: [{type: 'summary_text', text: streamState.reasoningText}]};
                        res.write(`event: response.reasoning_summary_part.done\ndata: ${JSON.stringify({type: 'response.reasoning_summary_part.done', output_index: streamState.outputIndex, summary_index: 0, item_id: streamState.reasoningItemId, part: {type: 'summary_text', text: streamState.reasoningText}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item})}\n\n`);
                        streamState.output.push(item);
                        streamState.outputIndex++;
                    }
                    if (streamState.messageOpen) {
                        const item = {type: 'message', id: streamState.currentMessageId, status: 'completed', role: 'assistant', content: [{type: 'output_text', text: streamState.textBuffer, annotations: []}]};
                        res.write(`event: response.content_part.done\ndata: ${JSON.stringify({type: 'response.content_part.done', output_index: streamState.outputIndex, content_index: 0, part: {type: 'output_text', text: streamState.textBuffer, annotations: []}})}\n\n`);
                        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({type: 'response.output_item.done', output_index: streamState.outputIndex, item})}\n\n`);
                        streamState.output.push(item);
                    }
                    if (streamState.started || streamState.output.length > 0) {
                        res.write(`event: response.completed\ndata: ${JSON.stringify({type: 'response.completed', response: {id: streamState.responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: streamModel || responsesReq.model || 'unknown', output: streamState.output, usage: {input_tokens: streamInputTokens, output_tokens: streamOutputTokens, total_tokens: streamInputTokens + streamOutputTokens}}})}\n\n`);
                    }
                }
                recordUsage(tenantId, streamInputTokens, streamOutputTokens, streamCacheHitTokens, responsesReq.model);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Relay Responses stream error:', err);
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，聚合后转 Responses 格式
            const {response: streamResp} = await callUpstream(upstream, (up) => {
                const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index), stream: true};
                return createChatCompletions(payload, up, {
                    requestType: 'Responses',
                    stream: false,
                    originalModel: responsesReq.model,
                    ...relayMeta
                });
            });

            const aggregated = await aggregateStreamResponse(streamResp.body);
            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, responsesReq.model);
            sampleRequest(tenantId, 'relay', responsesReq, aggregated, responsesReq.model).catch(() => {});

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
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        if (isResponsesWebSocketProtocolError(error)) {
            sendResponsesWebSocketProtocolError(res, error);
            return;
        }
        if (res.headersSent) {
            logger.warn(`Relay Responses WS stream failed after response started: ${error.message}`);
            if (!res.destroyed && !res.writableEnded) res.end();
            return;
        }
        logger.error('Relay: Failed to handle Responses API:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Responses Compact 请求 (/relay/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const authResult = await authenticateAndGetUpstream(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const {upstream, tenantId, upstreamManager} = authResult;
        const body = await parseBody(req);
        const compactReq = JSON.parse(body);

        if (isAnthropicUpstream(upstream)) {
            const chatReq = compactRequestToChat(compactReq);
            chatReq.messages = injectBehaviorRules(chatReq.messages);
            chatReq.messages = stripDynamicReminders(chatReq.messages);
            const anthropicPayload = chatRequestToAnthropic({
                ...chatReq,
                model: upstreamManager.resolveModel(chatReq.model, upstream.index),
                stream: false
            });
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const {response} = await callUpstream(upstream, (up) =>
                createAnthropicMessages(
                    anthropicPayload,
                    up,
                    {
                        requestType: 'ResponsesCompactViaAnthropic',
                        stream: false,
                        originalModel: compactReq.model,
                        ...tenantMeta
                    },
                    getAnthropicRequestHeaders(req)
                )
            );

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            const chatResponse = anthropicResponseToChat(parsed, compactReq.model);
            recordUsage(
                tenantId,
                chatResponse.usage?.prompt_tokens || 0,
                chatResponse.usage?.completion_tokens || 0,
                chatResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
                compactReq.model
            );
            sampleRequest(tenantId, 'relay', compactReq, parsed, compactReq.model).catch(() => {});
            sendJson(res, 200, chatResponseToCompact(chatResponse));
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const chatReq = compactRequestToChat(compactReq);
            chatReq.messages = injectBehaviorRules(chatReq.messages);
            // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
            chatReq.messages = stripDynamicReminders(chatReq.messages);
            const responsesPayload = chatRequestToResponses({
                ...chatReq,
                model: upstreamManager.resolveModel(chatReq.model, upstream.index),
                stream: false
            });
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const wsResult = await createResponsesWebSocket(responsesPayload, upstream, {
                requestType: 'ResponsesCompactWebSocket',
                stream: false,
                originalModel: compactReq.model,
                contextKey: extractConversationKey(req, responsesPayload, {tenantId}),
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordResponsesUsage(tenantId, completedResponse.usage, compactReq.model);
            sendJson(res, 200, chatResponseToCompact(responsesResponseToChat(completedResponse)));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const conversationKey = extractConversationKey(req, compactReq, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: tenantId ? `session-${tenantId}` : conversationKey
            };
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(
                    {...compactReq, model: upstreamManager.resolveModel(compactReq.model, up.index)},
                    up,
                    {
                        requestType: 'ResponsesCompactPassthrough',
                        stream: false,
                        originalModel: compactReq.model,
                        ...relayMeta
                    },
                    'responses/compact'
                )
            );

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordUsage(
                tenantId,
                parsed.usage?.input_tokens || 0,
                parsed.usage?.output_tokens || 0,
                parsed.usage?.input_tokens_details?.cached_tokens || 0,
                compactReq.model
            );
            sendJson(res, 200, parsed);
            return;
        }

        const chatReq = compactRequestToChat(compactReq);
        chatReq.messages = injectBehaviorRules(chatReq.messages);
        // 剥离纯记账性质的 system-reminder 块，避免动态内容破坏缓存前缀匹配
        chatReq.messages = stripDynamicReminders(chatReq.messages);

        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
        const conversationKey = extractConversationKey(req, chatReq, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: tenantId ? `session-${tenantId}` : conversationKey
        };

        chatReq.stream = true;
        const {response} = await callUpstream(upstream, (up) => {
            const payload = {...chatReq, model: upstreamManager.resolveModel(chatReq.model, up.index)};
            return createChatCompletions(payload, up, {
                requestType: 'ResponsesCompact',
                stream: false,
                originalModel: compactReq.model,
                ...relayMeta
            });
        });

        const aggregated = await aggregateStreamResponse(response.body);
        const inputTokens = aggregated.usage?.prompt_tokens || 0;
        const outputTokens = aggregated.usage?.completion_tokens || 0;
        const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
        recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, compactReq.model);
        sampleRequest(tenantId, 'relay', compactReq, aggregated, compactReq.model).catch(() => {});

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
        if (isResponsesWebSocketProtocolError(error)) {
            sendResponsesWebSocketProtocolError(res, error);
            return;
        }
        logger.error('Relay: Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/* ==================== WebSocket 端点 ==================== */

/**
 * Relay WS 处理器的核心请求逻辑（async generator）
 * 根据上游协议分发：
 * - Anthropic 上游 → 报错
 * - Responses WS 上游 → 直接 WS 转发
 * - Responses HTTP 上游 → SSE → WS 事件
 * - OpenAI Chat 上游 → Chat→Responses 事件
 *
 * @param {object} payload - Responses 请求体
 * @param {object} upstream - 上游配置
 * @param {object} upstreamManager - 上游管理器
 * @param {string} tenantId - 租户 ID
 * @param {object} tenantMeta - {tenantName, tenantUsername}
 * @param {AbortSignal} signal - 取消信号
 * @param {import('http').IncomingMessage} req - 原始 HTTP 请求
 */
async function* _relayWSHandleRequest(payload, upstream, upstreamManager, tenantId, tenantMeta, signal, req) {
    const resolvedModel = upstreamManager.resolveModel(payload.model, upstream.index);
    const conversationKey = extractConversationKey(req, payload, {tenantId});
    const relayMeta = {
        ...tenantMeta,
        conversationKey,
        sessionId: tenantId ? `session-${tenantId}` : conversationKey
    };

    if (isAnthropicUpstream(upstream)) {
        const chatReq = responsesRequestToChat({...payload, model: resolvedModel, stream: true});
        chatReq.messages = injectBehaviorRules(chatReq.messages);
        chatReq.messages = stripDynamicReminders(chatReq.messages);
        chatReq.stream = true;
        const anthropicPayload = chatRequestToAnthropic({
            ...chatReq,
            model: resolvedModel,
            stream: true
        });
        const {response} = await callUpstream(upstream, (up) =>
            createAnthropicMessages(
                anthropicPayload,
                up,
                {
                    requestType: 'ResponsesWSViaAnthropic',
                    stream: true,
                    originalModel: payload.model,
                    ...relayMeta
                },
                getAnthropicRequestHeaders(req)
            )
        );

        const streamState = createResponsesStreamState();
        for await (const chatChunk of anthropicStreamToChatChunks(response.body, parseSSEBlock, signal)) {
            if (signal?.aborted) break;
            const events = chatChunkToResponsesEvents(chatChunk, streamState);
            for (const ev of events) {
                yield {type: ev.event, data: ev.data};
            }
        }
        return;
    }

    if (isAnthropicUpstream(upstream)) {
        throw Object.assign(new Error('当前上游为 Anthropic 协议，不支持 Responses API'), {
            name: 'ResponsesWebSocketError',
            event: {type: 'error', error: {message: '当前上游为 Anthropic 协议，不支持 Responses API', code: 'protocol_mismatch'}}
        });
    }

    // Responses WS 上游：直接 WS 连接上游，转发事件
    if (isResponsesWebSocketUpstream(upstream)) {
        const wsPayload = {...payload, model: resolvedModel};
        const wsResult = await createResponsesWebSocket(wsPayload, upstream, {
            requestType: 'RelayResponsesWebSocketRelay',
            stream: true,
            originalModel: payload.model,
            contextKey: conversationKey,
            rejectUnauthorized: !upstream.skip_tls_verify,
            ...tenantMeta
        });

        // 必须用 finally 释放连接：WS server 在收到 response.completed 后会 break，
        // 触发 generator return()，try 块尾部的 release 永远到不了，连接将一直 busy 烂在池里
        let connHandled = false;
        try {
            for await (const event of wsResult.eventStream) {
                if (signal?.aborted) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    connHandled = true;
                    return;
                }
                yield event;
            }
        } catch (err) {
            discardResponsesWebSocketConnection(wsResult.conn);
            connHandled = true;
            throw err;
        } finally {
            if (!connHandled) releaseResponsesWebSocketConnection(wsResult.conn);
        }
        return;
    }

    // Responses HTTP 上游：透传 SSE → WS 事件
    if (isResponsesUpstream(upstream)) {
        const responsesPayload = {...payload, model: resolvedModel};
        const {response} = await callUpstream(upstream, (up) =>
            createResponses(responsesPayload, up, {
                requestType: 'ResponsesWS',
                stream: true,
                originalModel: payload.model,
                ...relayMeta
            })
        );

        let buffer = '';
        for await (const chunk of response.body) {
            if (signal?.aborted) break;
            buffer += chunk.toString('utf8');
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop() || '';

            for (const part of parts) {
                const {event, data} = parseSSEBlock(part);
                if (!data || data === '[DONE]') continue;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                yield {type: event || parsed.type, data: parsed};
            }
        }
        return;
    }

    // OpenAI Chat 上游：Chat → Responses 事件转换
    const chatReq = responsesRequestToChat({...payload, model: resolvedModel});
    chatReq.messages = injectBehaviorRules(chatReq.messages);
    chatReq.messages = stripDynamicReminders(chatReq.messages);
    chatReq.stream = true;

    const {response} = await callUpstream(upstream, (up) =>
        createChatCompletions(chatReq, up, {
            requestType: 'ResponsesWS',
            stream: true,
            originalModel: payload.model,
            ...relayMeta
        })
    );

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
}

/**
 * 处理 Relay Responses API WebSocket 连接
 * 客户端通过 WS 连接 /relay/v1/responses，发送标准 Responses API WS 协议
 *
 * 注意：鉴权已在 server.js 的 upgrade handler 中完成，
 * 并通过 req.tenantId 注入到这里。
 *
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {import('http').IncomingMessage} req - 原始 HTTP 请求（已注入 tenantId）
 */
export function handleRelayResponsesWS(clientWs, req) {
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            const tenantId = req.tenantId;
            const upstreamManager = await unifiedTenantManager.getUpstreamManager(tenantId);
            if (!upstreamManager) {
                throw Object.assign(new Error('Tenant upstream manager not found'), {
                    name: 'ResponsesWebSocketError',
                    event: {type: 'error', error: {message: 'Tenant upstream manager not found', code: 'server_error'}}
                });
            }

            const upstream = upstreamManager.getActiveUpstream();
            if (!upstream) {
                throw Object.assign(new Error('未配置可用上游'), {
                    name: 'ResponsesWebSocketError',
                    event: {type: 'error', error: {message: '未配置可用上游，请在管理面板 /relayFE 配置', code: 'no_upstream'}}
                });
            }

            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

            yield* _relayWSHandleRequest(payload, upstream, upstreamManager, tenantId, tenantMeta, signal, req);
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            recordUsage(req.tenantId, inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
}

/* ==================== 主路由 ==================== */

export async function routeRelayRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/relay' || pathname === '/relay/') {
        sendJson(res, 200, {
            name: 'Relay API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            tenantEnabled: unifiedTenantManager.isEnabled(),
            endpoints: {
                openai: {
                    chatCompletions: 'POST /relay/v1/chat/completions - OpenAI format',
                    responses: 'POST /relay/v1/responses - Responses API',
                    responsesCompact: 'POST /relay/v1/responses/compact - Responses Compact API',
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
    if (pathname === '/relay/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/relay/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/relay/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
