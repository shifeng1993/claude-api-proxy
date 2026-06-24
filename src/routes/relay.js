/**
 * Relay 路由处理�?- 支持 OpenAI �?Anthropic 双格式的聊天补全和模型列�?API
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
    ProviderUpstreamError
} from '../services/providers/upstream-api.js';
import {readBody, isNetworkError} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    injectBehaviorRules
} from '../services/relay/anthropic-adapter.js';
import {
    anthropicResponseToChat,
    rewriteOpenAIStream,
    stripDynamicReminders,
    buildConversationAnchorKey,
    sanitizeAnthropicPayload,
    extractCacheHitTokens,
    extractInputTokens,
    compactRequestToChat,
    chatResponseToCompact,
    mergeConsecutiveAssistantMessages,
    limitResponsesInputItems,
    createAnthropicStreamAccumulator,
    createChatStreamAccumulator,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    streamAnthropicSSEToChatChunks,
    createResponsesStreamAccumulator,
    canonicalFromAnthropicRequest,
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicStreamChatResponse,
    getRelayConversationDiagnostics,
    chatResponseToAnthropic,
    chatResponseToRelayResponses,
    chatRequestToRelayResponses,
    chatRequestToAnthropic,
    responsesResponseToRelayChat
} from '../services/relay/protocol-adapter.js';
import {isResponsesWebSocketProtocolError} from '../services/shared/responses-ws-client.js';
import {handleWSConnection} from '../services/shared/responses-ws-server.js';
import {
    RelayStateMissingError,
    relayConversationStore
} from '../services/session/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../services/session/responses-continuation.js';
import {
    compactChatRequestIfNeeded,
    isContextWindowExceededError
} from '../services/session/context-compactor.js';
import {aggregateStreamResponse} from '../services/providers/stream-response.js';
import {estimateMessageTokens} from '../utils/token-estimation.js';
import logger from '../utils/logger.js';

/* ==================== 工具函数 ==================== */

function sendJson(res, status, data) {
    if (res.headersSent) return;
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

function sendStateMissingOpenAIError(res, error) {
    sendJson(res, 400, {
        error: {
            message: error.message,
            type: 'invalid_request_error',
            code: 'state_missing'
        }
    });
}

function toResponsesWebSocketStateMissingError(error) {
    return Object.assign(error, {
        name: 'ResponsesWebSocketError',
        event: {
            type: 'error',
            error: {
                message: error.message,
                code: 'state_missing'
            }
        }
    });
}

function normalizeConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.session_id,
        payload.sessionId,
        metadata?.session_id,
        metadata?.sessionId,
        payload.conversation_id,
        payload.conversationId,
        metadata?.conversation_id,
        metadata?.conversationId,
        payload.thread_id,
        payload.threadId,
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
        req.headers['x-session-id'],
        req.headers['x-conversation-id'],
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

    const keyMeta = {
        ...meta,
        ...(req.relayClientConnectionId && !meta.clientConnectionId
            ? {clientConnectionId: req.relayClientConnectionId}
            : {})
    };

    // Fallback: 用共享的 buildConversationAnchorKey，优先识�?payload 内的 session-id�?
    const anchorPayload = payload && typeof payload === 'object'
        ? {...payload, messages: payload?.messages || payload?.input}
        : {messages: payload?.messages || payload?.input};
    return buildConversationAnchorKey(anchorPayload, keyMeta);
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
        extractInputTokens(usage),
        usage?.output_tokens || 0,
        extractCacheHitTokens(usage),
        model
    );
}

function recordCompletedResponseState(tenantId, conversationKey, response, sourceCanonicalSession) {
    if (!response || !conversationKey) return;
    relayConversationStore.recordResponsesResponse({
        tenantId,
        conversationKey,
        response,
        sourceCanonicalSession
    });
}

function limitResponsesPassthroughPayload(payload, {previousResponseId, requestType, conversationKey} = {}) {
    const limited = limitResponsesInputItems(payload, {previousResponseId});
    if (!limited.truncated) return limited.payload;

    logger.info(
        `Responses passthrough: truncated input items ${limited.originalLength}->${limited.retainedLength}`
        + `${requestType ? ` requestType=${requestType}` : ''}`
        + `${conversationKey ? ` conversationKey=${conversationKey}` : ''}`
        + ` previous_response_id=${limited.previousResponseId}`
    );
    return limited.payload;
}

function upstreamErrorStatus(err) {
    if (err instanceof ProviderUpstreamError && err.status) return err.status;
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

function parseSSEBlock(block) {
    const lines = block.split(/\r?\n/);
    let event;
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

function getSSEEventType(event, parsed) {
    return event || parsed?.type;
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
            yield {type: getSSEEventType(event, parsed), data: parsed};
        }
    }
}

function writeAnthropicEvent(res, event) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function streamResponsesEventsAsAnthropic(eventStream, res, signal, responsesAccumulator = null) {
    const responsesToChatBridge = createResponsesToChatStreamBridge();
    const chatToAnthropicBridge = createChatToAnthropicStreamBridge();
    let usage = null;

    for await (const event of eventStream) {
        if (signal?.aborted) break;
        if (event.type === 'response.completed') {
            usage = event.data?.response?.usage || usage;
        }
        if (responsesAccumulator) responsesAccumulator.feed(event.type, event.data);
        const chatChunks = responsesToChatBridge.feed(event.type, event.data);
        for (const chatChunk of chatChunks) {
            const anthropicEvents = chatToAnthropicBridge.feed(chatChunk);
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

    if (usage.input_tokens !== undefined) {
        usageState.inputTokens = extractInputTokens(usage);
    }
    if (usage.output_tokens !== undefined) usageState.outputTokens = usage.output_tokens;
    usageState.cacheHitTokens = Math.max(usageState.cacheHitTokens, extractCacheHitTokens(usage));
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

async function generateRelayContextSummary({
    summaryRequest,
    upstream,
    upstreamManager,
    tenantId,
    tenantMeta = {},
    conversationKey,
    originalModel,
    requestType,
    req
}) {
    const model = upstreamManager.resolveModel(summaryRequest.model || originalModel, upstream.index);
    const payload = {...summaryRequest, model, stream: false};
    const compactConversationKey = conversationKey ? `${conversationKey}:compact` : undefined;
    const compactMeta = {
        requestType: `${requestType}ContextCompaction`,
        stream: false,
        originalModel,
        conversationKey: compactConversationKey,
        sessionId: compactConversationKey,
        ...tenantMeta
    };

    if (isAnthropicUpstream(upstream)) {
        const anthropicPayload = chatRequestToAnthropic(payload);
        const {response} = await callUpstream(upstream, (up) =>
            createAnthropicMessages(
                anthropicPayload,
                up,
                compactMeta,
                getAnthropicRequestHeaders(req)
            )
        );
        const responseBody = await readResponseBody(response.body);
        const parsed = JSON.parse(responseBody);
        const chatResponse = anthropicResponseToChat(parsed, originalModel || model);
        recordUsage(
            tenantId,
            chatResponse.usage?.prompt_tokens || 0,
            chatResponse.usage?.completion_tokens || 0,
            extractCacheHitTokens(chatResponse.usage),
            model
        );
        return chatResponse.choices?.[0]?.message?.content || '';
    }

    const {response} = await callUpstream(upstream, (up) =>
        createChatCompletions(payload, up, compactMeta)
    );
    const responseBody = await readResponseBody(response.body);
    const parsed = JSON.parse(responseBody);
    recordUsage(
        tenantId,
        parsed.usage?.prompt_tokens || 0,
        parsed.usage?.completion_tokens || 0,
        extractCacheHitTokens(parsed.usage),
        model
    );
    return parsed.choices?.[0]?.message?.content || '';
}

async function compactRelayChatRequest({
    chatRequest,
    upstream,
    upstreamManager,
    tenantId,
    tenantMeta,
    conversationKey,
    originalModel,
    requestType,
    req,
    force = false,
    reason
}) {
    const result = await compactChatRequestIfNeeded({
        chatRequest,
        force,
        reason,
        summarize: ({summaryRequest}) => generateRelayContextSummary({
            summaryRequest,
            upstream,
            upstreamManager,
            tenantId,
            tenantMeta,
            conversationKey,
            originalModel,
            requestType,
            req
        })
    });

    if (result.compacted) {
        relayConversationStore.saveChatRequest({
            tenantId,
            conversationKey,
            request: result.chatRequest
        });
        logger.info(
            `Relay context compacted (${requestType}): messages ${result.oldMessageCount}+${result.recentMessageCount}, tokens ${result.estimatedTokens}->${result.compactedTokens}`
        );
    }

    return result;
}

async function invokeWithRelayContextCompaction({
    chatRequest,
    compactOptions,
    invoke
}) {
    let prepared = {chatRequest};
    try {
        prepared = await compactRelayChatRequest({
            ...compactOptions,
            chatRequest,
            force: false
        });
    } catch (error) {
        logger.warn(`Relay context proactive compaction skipped: ${error.message}`);
        prepared = {chatRequest};
    }

    try {
        return {
            chatRequest: prepared.chatRequest,
            result: await invoke(prepared.chatRequest),
            retriedAfterCompaction: false
        };
    } catch (error) {
        if (!isContextWindowExceededError(error)) throw error;

        logger.warn(`Relay context exceeded, compacting and retrying once: ${error.message}`);
        let retryPrepared;
        try {
            retryPrepared = await compactRelayChatRequest({
                ...compactOptions,
                chatRequest: prepared.chatRequest,
                force: true,
                reason: 'context-window-exceeded'
            });
        } catch (compactionError) {
            logger.warn(`Relay context reactive compaction failed: ${compactionError.message}`);
            throw error;
        }
        if (!retryPrepared.compacted) throw error;

        return {
            chatRequest: retryPrepared.chatRequest,
            result: await invoke(retryPrepared.chatRequest),
            retriedAfterCompaction: true
        };
    }
}

function prepareRelayOutboundChatRequest(chatRequest, {model, stream} = {}) {
    const outbound = cloneJson(chatRequest || {});
    outbound.model = model || outbound.model;
    if (stream !== undefined) outbound.stream = stream;
    outbound.messages = injectBehaviorRules(outbound.messages || [], outbound.model);
    outbound.messages = stripDynamicReminders(outbound.messages);
    mergeConsecutiveAssistantMessages(outbound.messages);
    return outbound;
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
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
        return `当前上游协议�?${protocol}，请改用 ${endpoint} 或切换上游类型`;
    }
    return `当前上游协议�?${protocol}，该端点需�?${expectedProtocol} 上游支持`;
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
        return {error: {status: 503, message: '未配置可用上游，请在管理面板 /dashboard 配置'}};
    }

    return {upstream, tenantId, upstreamManager};
}

/**
 * 调用上游，失败直接抛�?
 */
async function callUpstream(upstream, fn) {
    const response = await fn(upstream);
    if (response.status >= 200 && response.status < 300) {
        return {response, upstream};
    }
    const errorBody = await readBody(response.body);
    throw new Error(`上游�?{upstream.name}」返�?HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
}

function recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown', samplePayload = null, sampleResponse = null) {
    if (!tenantId) return;
    unifiedTenantManager.incrementApiCallCount(tenantId, 'relay');
    unifiedTenantManager.incrementTokenUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens);
    unifiedTenantManager.recordDailyUsage(tenantId, 'relay', inputTokens, outputTokens, cacheHitTokens, 0, model);
}

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式�?/relay/v1/chat/completions 请求
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
        const relayStatsModel = upstreamManager.resolveModel(openAIPayload.model, upstream.index);
        const baseConversationKey = extractConversationKey(req, openAIPayload, {tenantId});

        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages, relayStatsModel);
        openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);
        mergeConsecutiveAssistantMessages(openAIPayload.messages);
        relayConversationStore.saveChatRequest({
            tenantId,
            conversationKey: baseConversationKey,
            request: openAIPayload
        });

        if (isAnthropicUpstream(upstream)) {
            const anthropicPayload = chatRequestToAnthropic({
                ...openAIPayload,
                model: relayStatsModel
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
                const chatAccumulator = createChatStreamAccumulator({model: openAIPayload.model});
                for await (const chatChunk of streamAnthropicSSEToChatChunks(response.body, parseSSEBlock)) {
                    if (chatChunk.usage) finalUsage = chatChunk.usage;
                    chatAccumulator.feed(chatChunk);
                    res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                }
                const chatResponse = chatAccumulator.toChatResponse();
                if (chatResponse) {
                    relayConversationStore.recordChatResponse({
                        tenantId,
                        conversationKey: baseConversationKey,
                        response: chatResponse,
                        sourceCanonicalSession: canonicalFromAnthropicStreamChatResponse(chatResponse, {
                            tenantId,
                            conversationKey: baseConversationKey
                        })
                    });
                }
                recordUsage(
                    tenantId,
                    finalUsage?.prompt_tokens || 0,
                    finalUsage?.completion_tokens || 0,
                    extractCacheHitTokens(finalUsage),
                    relayStatsModel
                );
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            const chatResponse = anthropicResponseToChat(parsed, openAIPayload.model);
            relayConversationStore.recordAnthropicResponse({
                tenantId,
                conversationKey: baseConversationKey,
                response: parsed,
                chatResponse
            });
            const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
            recordUsage(
                tenantId,
                chatResponse.usage?.prompt_tokens || 0,
                chatResponse.usage?.completion_tokens || 0,
                cacheHitTokens,
                relayStatsModel
            );
            sendJson(res, 200, chatResponse);
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const responsesPayload = chatRequestToRelayResponses({
                ...openAIPayload,
                model: relayStatsModel
            });
            const continuation = prepareResponsesContinuationPayload({
                conversationStore: relayConversationStore,
                tenantId,
                conversationKey: baseConversationKey,
                request: responsesPayload,
                requestType: 'ChatCompletionsViaResponsesWS'
            });
            const stateConversationKey = continuation.conversationKey || baseConversationKey;
            const wsResult = await createResponsesWebSocket(continuation.request, upstream, {
                requestType: 'ChatCompletionsViaResponsesWS',
                stream: openAIPayload.stream,
                originalModel: openAIPayload.model,
                contextKey: stateConversationKey,
                sessionId: stateConversationKey,
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const responsesToChatBridge = createResponsesToChatStreamBridge({model: relayStatsModel});
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
                let usage = null;
                let completedResponse = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        responsesAccumulator.feed(event.type, event.data);
                        if (event.type === 'response.completed') {
                            usage = event.data?.response?.usage || usage;
                            completedResponse = event.data?.response || completedResponse;
                        }
                        const chunks = responsesToChatBridge.feed(event.type, event.data);
                        for (const chatChunk of chunks) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }
                    }
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(tenantId, stateConversationKey, responseForState);
                recordResponsesUsage(tenantId, usage || responseForState?.usage, relayStatsModel);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
            recordResponsesUsage(tenantId, completedResponse.usage, relayStatsModel);
            sendJson(res, 200, responsesResponseToRelayChat(completedResponse));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = chatRequestToRelayResponses({
                ...openAIPayload,
                model: relayStatsModel
            });

            const conversationKey = extractConversationKey(req, responsesPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: conversationKey
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

                const responsesToChatBridge = createResponsesToChatStreamBridge({model: relayStatsModel});
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
                let buffer = '';
                let usage = null;
                let completedResponse = null;

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
                        const eventType = getSSEEventType(event, parsed);
                        responsesAccumulator.feed(eventType, parsed);

                        if (eventType === 'response.completed') {
                            usage = parsed.response?.usage || usage;
                            completedResponse = parsed.response || completedResponse;
                        }

                        const chunks = responsesToChatBridge.feed(eventType, parsed);
                        for (const chatChunk of chunks) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }

                        if (eventType === 'response.completed') {
                            res.write('data: [DONE]\n\n');
                        }
                    }
                });

                response.body.on('end', () => {
                    if (!responsesToChatBridge.completed) {
                        for (const chatChunk of responsesToChatBridge.finish()) {
                            res.write(`data: ${JSON.stringify(chatChunk)}\n\n`);
                        }
                        res.write('data: [DONE]\n\n');
                    }
                    const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                    recordCompletedResponseState(tenantId, conversationKey, responseForState);
                    const usageForRecord = usage || responseForState?.usage;
                    recordUsage(
                        tenantId,
                        extractInputTokens(usageForRecord),
                        usageForRecord?.output_tokens || 0,
                        extractCacheHitTokens(usageForRecord),
                        relayStatsModel
                    );
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
                extractInputTokens(parsed.usage),
                parsed.usage?.output_tokens || 0,
                extractCacheHitTokens(parsed.usage),
                relayStatsModel
            );
            recordCompletedResponseState(tenantId, conversationKey, parsed);
            sendJson(res, 200, responsesResponseToRelayChat(parsed));
            return;
        }

        const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: conversationKey
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
            _streamOpenAIPassthrough(response, res, tenantId, tenantInfo, relayStatsModel, conversationKey);
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
                relayStatsModel
            );
            relayConversationStore.recordChatResponse({
                tenantId,
                conversationKey,
                response: parsed
            });
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        if (error instanceof RelayStateMissingError) {
            sendStateMissingOpenAIError(res, error);
            return;
        }
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
 * 处理 Anthropic 格式�?/relay/anthropic/v1/messages 请求
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
        const relayStatsModel = upstreamManager.resolveModel(anthropicPayload.model, upstream.index);
        const baseConversationKey = extractConversationKey(req, anthropicPayload, {tenantId});
        const openAIPayload = anthropicToOpenAI(anthropicPayload, relayStatsModel);
        openAIPayload.messages = injectBehaviorRules(openAIPayload.messages, relayStatsModel);
        openAIPayload.messages = stripDynamicReminders(openAIPayload.messages);
        mergeConsecutiveAssistantMessages(openAIPayload.messages);
        relayConversationStore.saveChatRequest({
            tenantId,
            conversationKey: baseConversationKey,
            request: openAIPayload
        });

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
                const anthropicAccumulator = createAnthropicStreamAccumulator({model: anthropicPayload.model});
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
                            const parsed = JSON.parse(data);
                            handleAnthropicUsageEvent(event, parsed, usageState);
                            anthropicAccumulator.feed(event, parsed);
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    const anthropicResponse = anthropicAccumulator.toAnthropicResponse();
                    if (anthropicResponse) {
                        relayConversationStore.recordAnthropicResponse({
                            tenantId,
                            conversationKey: baseConversationKey,
                            response: anthropicResponse,
                            chatResponse: anthropicResponseToChat(anthropicResponse, anthropicPayload.model)
                        });
                    }
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
                extractInputTokens(parsed.usage) || estimateAnthropicInputTokens(anthropicPayload),
                parsed.usage?.output_tokens || 0,
                extractCacheHitTokens(parsed.usage),
                parsed.model || relayStatsModel
            );
            const chatResponse = anthropicResponseToChat(parsed, anthropicPayload.model);
            relayConversationStore.recordAnthropicResponse({
                tenantId,
                conversationKey: baseConversationKey,
                response: parsed,
                chatResponse
            });
            sendJson(res, 200, parsed);
            return;
        }

        // 转换�?OpenAI 格式
        if (isResponsesWebSocketUpstream(upstream)) {
            const responsesPayload = chatRequestToRelayResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index),
                stream: anthropicPayload.stream
            });
            const continuation = prepareResponsesContinuationPayload({
                conversationStore: relayConversationStore,
                tenantId,
                conversationKey: baseConversationKey,
                request: responsesPayload,
                requestType: 'AnthropicViaResponsesWebSocket'
            });
            const stateConversationKey = continuation.conversationKey || baseConversationKey;
            const wsResult = await createResponsesWebSocket(continuation.request, upstream, {
                requestType: 'AnthropicViaResponsesWebSocket',
                stream: anthropicPayload.stream,
                originalModel: anthropicPayload.model,
                contextKey: stateConversationKey,
                sessionId: stateConversationKey,
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
                let completedResponse = null;
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
                try {
                    async function* trackCompletedResponses(stream) {
                        for await (const event of stream) {
                            if (event.type === 'response.completed') {
                                completedResponse = event.data?.response || completedResponse;
                            }
                            yield event;
                        }
                    }
                    usage = await streamResponsesEventsAsAnthropic(
                        trackCompletedResponses(wsResult.eventStream),
                        res,
                        req.signal,
                        responsesAccumulator
                    );
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(tenantId, stateConversationKey, responseForState);
                recordResponsesUsage(tenantId, usage || responseForState?.usage, relayStatsModel);
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
            recordResponsesUsage(tenantId, completedResponse.usage, relayStatsModel);
            const chatResponse = responsesResponseToRelayChat(completedResponse);
            sendJson(res, 200, chatResponseToAnthropic(chatResponse));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = chatRequestToRelayResponses({
                ...openAIPayload,
                model: upstreamManager.resolveModel(openAIPayload.model, upstream.index),
                stream: anthropicPayload.stream
            });
            const conversationKey = extractConversationKey(req, responsesPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: conversationKey
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

                let completedResponse = null;
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
                async function* trackCompletedResponses(stream) {
                    for await (const event of stream) {
                        if (event.type === 'response.completed') {
                            completedResponse = event.data?.response || completedResponse;
                        }
                        yield event;
                    }
                }
                const usage = await streamResponsesEventsAsAnthropic(
                    trackCompletedResponses(parseResponsesSSEEvents(response.body, req.signal)),
                    res,
                    req.signal,
                    responsesAccumulator
                );
                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(tenantId, conversationKey, responseForState);
                recordResponsesUsage(tenantId, usage || responseForState?.usage, relayStatsModel);
                res.end();
                return;
            }

            const responseBody = await readResponseBody(response.body);
            const parsed = JSON.parse(responseBody);
            recordCompletedResponseState(tenantId, conversationKey, parsed);
            recordResponsesUsage(tenantId, parsed.usage, relayStatsModel);
            const chatResponse = responsesResponseToRelayChat(parsed);
            sendJson(res, 200, chatResponseToAnthropic(chatResponse));
            return;
        }

        if (anthropicPayload.stream) {
            const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: conversationKey
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

            const chatToAnthropicBridge = createChatToAnthropicStreamBridge({model: anthropicPayload.model});
            const chatAccumulator = createChatStreamAccumulator({model: openAIPayload.model});
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
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }
                    chatAccumulator.feed(data);

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                    }

                    for (const anthropicEvent of chatToAnthropicBridge.feed(data)) {
                        writeAnthropicEvent(res, anthropicEvent);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                if (!chatToAnthropicBridge.finished) {
                    for (const anthropicEvent of chatToAnthropicBridge.finish()) {
                        writeAnthropicEvent(res, anthropicEvent);
                    }
                }
                const chatResponse = chatAccumulator.toChatResponse();
                if (chatResponse) {
                    relayConversationStore.recordChatResponse({
                        tenantId,
                        conversationKey,
                        response: chatResponse
                    });
                }
                recordUsage(
                    tenantId,
                    streamInputTokens,
                    streamOutputTokens,
                    streamCacheHitTokens,
                    relayStatsModel
                );
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error(`Relay Anthropic stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                writeAnthropicEvent(res, {
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: err?.message || 'Upstream stream failed'
                    }
                });
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，用 aggregateStreamResponse 聚合
            openAIPayload.stream = true;
            const conversationKey = extractConversationKey(req, openAIPayload, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: conversationKey
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
            recordUsage(
                tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                relayStatsModel
            );

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
                            reasoning_content: aggregated.reasoningContent || undefined,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop'
                    }
                ],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };
            relayConversationStore.recordChatResponse({
                tenantId,
                conversationKey,
                response: openAIResponse
            });
            sendJson(res, 200, chatResponseToAnthropic(openAIResponse));
        }
    } catch (error) {
        logger.error(`Relay: Failed to handle Anthropic messages${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        if (!res.headersSent) {
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        } else {
            // 流式响应已开始，无法再写 headers，直接结束响�?
            try { res.end(); } catch {}
        }
    }
}

/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 �?OpenAI 上游），�?reasoning_content 做缓冲合�?*/
function _streamOpenAIPassthrough(response, res, tenantId, tenantInfo = '', model = 'unknown', conversationKey = null) {
    const chatAccumulator = createChatStreamAccumulator({model});
    rewriteOpenAIStream(
        res,
        response.body,
        (inputTokens, outputTokens, cacheHitTokens) => {
            const chatResponse = chatAccumulator.toChatResponse();
            if (chatResponse && conversationKey) {
                relayConversationStore.recordChatResponse({
                    tenantId,
                    conversationKey,
                    response: chatResponse
                });
            }
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, model);
        },
        (chunk) => chatAccumulator.feed(chunk),
        {logger}
    );
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
 * �?Responses 格式转为 Chat Completions 发给上游，再将响应转�?Responses 格式
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
        const relayStatsModel = upstreamManager.resolveModel(responsesReq.model, upstream.index);

        if (isAnthropicUpstream(upstream)) {
            const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
            const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
                tenantId,
                conversationKey,
                request: responsesReq
            });
            let chatReq = hydrated.chatRequest;
            chatReq.stream = responsesReq.stream;
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const stateConversationKey = hydrated.conversationKey || conversationKey;
            const invocation = await invokeWithRelayContextCompaction({
                chatRequest: chatReq,
                compactOptions: {
                    upstream,
                    upstreamManager,
                    tenantId,
                    tenantMeta,
                    conversationKey: stateConversationKey,
                    originalModel: responsesReq.model,
                    requestType: 'ResponsesViaAnthropic',
                    req
                },
                invoke: (readyChatReq) => {
                    const outboundChatReq = prepareRelayOutboundChatRequest(readyChatReq, {
                        model: upstreamManager.resolveModel(readyChatReq.model, upstream.index),
                        stream: responsesReq.stream
                    });
                    const anthropicPayload = chatRequestToAnthropic(outboundChatReq);
                    return callUpstream(upstream, (up) =>
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
                }
            });
            chatReq = invocation.chatRequest;
            const {response} = invocation.result;

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
                const responsesAccumulator = createResponsesStreamAccumulator({model: responsesReq.model});
                const sourceChatAccumulator = createChatStreamAccumulator({model: responsesReq.model});
                let finalUsage = null;
                let completedResponse = null;
                for await (const chatChunk of streamAnthropicSSEToChatChunks(response.body, parseSSEBlock, req.signal)) {
                    if (chatChunk.usage) finalUsage = chatChunk.usage;
                    sourceChatAccumulator.feed(chatChunk);
                    const events = chatToResponsesBridge.feed(chatChunk);
                    for (const ev of events) {
                        responsesAccumulator.feed(ev.event, ev.data);
                        if (ev.event === 'response.completed') {
                            completedResponse = ev.data?.response || completedResponse;
                        }
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                const sourceChatResponse = sourceChatAccumulator.toChatResponse();
                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(
                    tenantId,
                    stateConversationKey,
                    responseForState,
                    sourceChatResponse
                        ? canonicalFromAnthropicStreamChatResponse(sourceChatResponse, {
                            tenantId,
                            conversationKey: stateConversationKey
                        })
                        : null
                );
                recordUsage(
                    tenantId,
                    finalUsage?.prompt_tokens || 0,
                    finalUsage?.completion_tokens || 0,
                    extractCacheHitTokens(finalUsage),
                    relayStatsModel
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
                extractCacheHitTokens(chatResponse.usage),
                relayStatsModel
            );
            const responsesResponse = chatResponseToRelayResponses(chatResponse);
            recordCompletedResponseState(
                tenantId,
                stateConversationKey,
                responsesResponse,
                canonicalFromAnthropicResponse(parsed, {tenantId, conversationKey: stateConversationKey})
            );
            sendJson(res, 200, responsesResponse);
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const wsPayload = {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, upstream.index)};
            const conversationKey = extractConversationKey(req, wsPayload, {tenantId});
            const prepared = relayConversationStore.prepareResponsesPassthrough({
                tenantId,
                conversationKey,
                request: wsPayload
            });
            const stateConversationKey = prepared.conversationKey || conversationKey;
            const limitedRequest = limitResponsesPassthroughPayload(prepared.request, {
                previousResponseId: prepared.lastResponseId,
                requestType: 'ResponsesWebSocket',
                conversationKey: stateConversationKey
            });
            const wsResult = await createResponsesWebSocket(limitedRequest, upstream, {
                requestType: 'ResponsesWebSocket',
                stream: responsesReq.stream,
                originalModel: responsesReq.model,
                contextKey: stateConversationKey,
                sessionId: stateConversationKey,
                rejectUnauthorized: !upstream.skip_tls_verify,
                autoLink: false,
                ...tenantMeta
            });

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const responsesToResponsesBridge = createResponsesToResponsesStreamBridge({model: responsesReq.model});
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
                let usage = null;
                let completedResponse = null;
                try {
                    for await (const event of wsResult.eventStream) {
                        if (event.type === 'response.completed') {
                            usage = event.data?.response?.usage || usage;
                            completedResponse = event.data?.response || completedResponse;
                        }
                        const responseEvents = responsesToResponsesBridge.feed(event.type, event.data);
                        for (const responseEvent of responseEvents) {
                            responsesAccumulator.feed(responseEvent.event, responseEvent.data);
                            res.write(`event: ${responseEvent.event}\ndata: ${JSON.stringify(responseEvent.data)}\n\n`);
                        }
                    }
                    releaseResponsesWebSocketConnection(wsResult.conn);
                } catch (error) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    throw error;
                }

                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(tenantId, stateConversationKey, responseForState);
                recordResponsesUsage(tenantId, usage || responseForState?.usage, relayStatsModel);
                res.end();
                return;
            }

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
            recordResponsesUsage(tenantId, completedResponse.usage, relayStatsModel);
            sendJson(res, 200, completedResponse);
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
            const responsesPayload = {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, upstream.index)};
            const prepared = relayConversationStore.prepareResponsesPassthrough({
                tenantId,
                conversationKey,
                request: responsesPayload
            });
            const stateConversationKey = prepared.conversationKey || conversationKey;
            const limitedRequest = limitResponsesPassthroughPayload(prepared.request, {
                previousResponseId: prepared.lastResponseId,
                requestType: 'ResponsesPassthrough',
                conversationKey: stateConversationKey
            });
            const relayMeta = {
                ...tenantMeta,
                conversationKey: stateConversationKey,
                sessionId: stateConversationKey
            };
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(
                    {...limitedRequest, model: upstreamManager.resolveModel(responsesReq.model, up.index)},
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
                let completedResponse = null;
                const responsesAccumulator = createResponsesStreamAccumulator({model: relayStatsModel});
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
                            const parsed = JSON.parse(data);
                            const eventType = getSSEEventType(event, parsed);
                            responsesAccumulator.feed(eventType, parsed);
                            if (eventType !== 'response.completed') continue;
                            const completed = parsed.response;
                            usage = completed?.usage || usage;
                            completedResponse = completed || completedResponse;
                        } catch {
                            continue;
                        }
                    }
                });

                response.body.on('end', () => {
                    const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                    recordCompletedResponseState(tenantId, stateConversationKey, responseForState);
                    const usageForRecord = usage || responseForState?.usage;
                    recordUsage(
                        tenantId,
                        extractInputTokens(usageForRecord),
                        usageForRecord?.output_tokens || 0,
                        extractCacheHitTokens(usageForRecord),
                        relayStatsModel
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
            recordCompletedResponseState(tenantId, stateConversationKey, parsed);
            recordUsage(
                tenantId,
                extractInputTokens(parsed.usage),
                parsed.usage?.output_tokens || 0,
                extractCacheHitTokens(parsed.usage),
                relayStatsModel
            );
            sendJson(res, 200, parsed);
            return;
        }

        // Responses �?Chat Completions
        const responsesConversationKey = extractConversationKey(req, responsesReq, {tenantId});
        const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
            tenantId,
            conversationKey: responsesConversationKey,
            request: responsesReq
        });
        let chatReq = hydrated.chatRequest;
        // Keep the stored transcript raw; outbound-only prompt shaping happens in prepareRelayOutboundChatRequest.

        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
        const conversationKey = hydrated.conversationKey || responsesConversationKey || extractConversationKey(req, chatReq, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: conversationKey
        };
        const compactOptions = {
            upstream,
            upstreamManager,
            tenantId,
            tenantMeta,
            conversationKey,
            originalModel: responsesReq.model,
            requestType: 'ResponsesViaChat',
            req
        };

        if (responsesReq.stream) {
            const invocation = await invokeWithRelayContextCompaction({
                chatRequest: chatReq,
                compactOptions,
                invoke: (readyChatReq) => callUpstream(upstream, (up) => {
                    const payload = prepareRelayOutboundChatRequest(readyChatReq, {
                        model: upstreamManager.resolveModel(readyChatReq.model, up.index),
                        stream: responsesReq.stream
                    });
                    return createChatCompletions(payload, up, {
                        requestType: 'Responses',
                        stream: responsesReq.stream,
                        originalModel: responsesReq.model,
                        ...relayMeta
                    });
                })
            });
            chatReq = invocation.chatRequest;
            const {response} = invocation.result;

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
            const responsesAccumulator = createResponsesStreamAccumulator({model: responsesReq.model});
            let completedResponse = null;
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
                        responsesAccumulator.feed(ev.event, ev.data);
                        if (ev.event === 'response.completed') {
                            completedResponse = ev.data?.response || completedResponse;
                        }
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                if (!chatToResponsesBridge.finished) {
                    for (const ev of chatToResponsesBridge.finish()) {
                        responsesAccumulator.feed(ev.event, ev.data);
                        if (ev.event === 'response.completed') {
                            completedResponse = ev.data?.response || completedResponse;
                        }
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                const responseForState = completedResponse || responsesAccumulator.toResponsesResponse();
                recordCompletedResponseState(tenantId, conversationKey, responseForState);
                recordUsage(tenantId, streamInputTokens, streamOutputTokens, streamCacheHitTokens, relayStatsModel);
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Relay Responses stream error:', err);
                res.end();
            });
        } else {
            // 非流式：强制 stream=true 请求上游，聚合后�?Responses 格式
            const invocation = await invokeWithRelayContextCompaction({
                chatRequest: chatReq,
                compactOptions,
                invoke: (readyChatReq) => callUpstream(upstream, (up) => {
                    const payload = prepareRelayOutboundChatRequest(readyChatReq, {
                        model: upstreamManager.resolveModel(readyChatReq.model, up.index),
                        stream: true
                    });
                    return createChatCompletions(payload, up, {
                        requestType: 'Responses',
                        stream: false,
                        originalModel: responsesReq.model,
                        ...relayMeta
                    });
                })
            });
            chatReq = invocation.chatRequest;
            const {response: streamResp} = invocation.result;

            const aggregated = await aggregateStreamResponse(streamResp.body);
            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, relayStatsModel);

            const chatResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || chatReq.model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: aggregated.toolCalls.length > 0 ? (aggregated.content || '') : (aggregated.content || null),
                        reasoning_content: aggregated.reasoningContent || undefined,
                        tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                    },
                    finish_reason: aggregated.finishReason || 'stop'
                }],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            const responsesResponse = chatResponseToRelayResponses(chatResponse);
            recordCompletedResponseState(tenantId, conversationKey, responsesResponse);
            sendJson(res, 200, responsesResponse);
        }
    } catch (error) {
        if (error instanceof RelayStateMissingError) {
            sendStateMissingOpenAIError(res, error);
            return;
        }
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
        const relayStatsModel = upstreamManager.resolveModel(compactReq.model, upstream.index);

        if (isAnthropicUpstream(upstream)) {
            const chatReq = compactRequestToChat(compactReq);
            chatReq.messages = injectBehaviorRules(chatReq.messages, relayStatsModel);
            chatReq.messages = stripDynamicReminders(chatReq.messages);
            mergeConsecutiveAssistantMessages(chatReq.messages);
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
                extractCacheHitTokens(chatResponse.usage),
                relayStatsModel
            );
            sendJson(res, 200, chatResponseToCompact(chatResponse));
            return;
        }

        if (isResponsesWebSocketUpstream(upstream)) {
            const conversationKey = extractConversationKey(req, compactReq, {tenantId});
            const chatReq = compactRequestToChat(compactReq);
            chatReq.messages = injectBehaviorRules(chatReq.messages, relayStatsModel);
            chatReq.messages = stripDynamicReminders(chatReq.messages);
            mergeConsecutiveAssistantMessages(chatReq.messages);
            const responsesPayload = chatRequestToRelayResponses({
                ...chatReq,
                model: upstreamManager.resolveModel(chatReq.model, upstream.index),
                stream: false
            });
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const limitedRequest = limitResponsesPassthroughPayload(responsesPayload, {
                requestType: 'ResponsesCompactWebSocket',
                conversationKey
            });
            const wsResult = await createResponsesWebSocket(limitedRequest, upstream, {
                requestType: 'ResponsesCompactWebSocket',
                stream: false,
                originalModel: compactReq.model,
                contextKey: conversationKey,
                sessionId: conversationKey,
                rejectUnauthorized: !upstream.skip_tls_verify,
                ...tenantMeta
            });

            const completedResponse = await collectResponsesWebSocketResponse(wsResult);
            recordResponsesUsage(tenantId, completedResponse.usage, relayStatsModel);
            sendJson(res, 200, chatResponseToCompact(responsesResponseToRelayChat(completedResponse)));
            return;
        }

        if (isResponsesUpstream(upstream)) {
            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const conversationKey = extractConversationKey(req, compactReq, {tenantId});
            const relayMeta = {
                ...tenantMeta,
                conversationKey,
                sessionId: conversationKey
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
                extractInputTokens(parsed.usage),
                parsed.usage?.output_tokens || 0,
                extractCacheHitTokens(parsed.usage),
                relayStatsModel
            );
            sendJson(res, 200, parsed);
            return;
        }

        const chatReq = compactRequestToChat(compactReq);
        chatReq.messages = injectBehaviorRules(chatReq.messages, relayStatsModel);
        chatReq.messages = stripDynamicReminders(chatReq.messages);
        mergeConsecutiveAssistantMessages(chatReq.messages);

        const tenant = await unifiedTenantManager.getTenant(tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
        const conversationKey = extractConversationKey(req, chatReq, {tenantId});
        const relayMeta = {
            ...tenantMeta,
            conversationKey,
            sessionId: conversationKey
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
        recordUsage(tenantId, inputTokens, outputTokens, cacheHitTokens, relayStatsModel);

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
 * Relay WS 处理器的核心请求逻辑（async generator�?
 * 根据上游协议分发�?
 * - Anthropic 上游 �?hydrate Responses 增量上下文后�?Anthropic stream
 * - Responses WS 上游 �?直接 WS 转发
 * - Responses HTTP 上游 �?SSE �?WS 事件
 * - OpenAI Chat 上游 �?Chat→Responses 事件
 *
 * @param {object} payload - Responses 请求�?
 * @param {object} upstream - 上游配置
 * @param {object} upstreamManager - 上游管理�?
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
        sessionId: conversationKey
    };

    if (isAnthropicUpstream(upstream)) {
        let hydrated;
        try {
            hydrated = relayConversationStore.hydrateResponsesForFullHistory({
                tenantId,
                conversationKey,
                request: {...payload, model: resolvedModel, stream: true}
            });
        } catch (error) {
            if (error instanceof RelayStateMissingError) throw toResponsesWebSocketStateMissingError(error);
            throw error;
        }
        let chatReq = hydrated.chatRequest;
        chatReq.stream = true;
        const stateConversationKey = hydrated.conversationKey || conversationKey;
        const stateRelayMeta = {...relayMeta, conversationKey: stateConversationKey};
        const invocation = await invokeWithRelayContextCompaction({
            chatRequest: chatReq,
            compactOptions: {
                upstream,
                upstreamManager,
                tenantId,
                tenantMeta,
                conversationKey: stateConversationKey,
                originalModel: payload.model,
                requestType: 'ResponsesWSViaAnthropic',
                req
            },
            invoke: (readyChatReq) => {
                const outboundChatReq = prepareRelayOutboundChatRequest(readyChatReq, {
                    model: resolvedModel,
                    stream: true
                });
                const anthropicPayload = chatRequestToAnthropic(outboundChatReq);
                return callUpstream(upstream, (up) =>
                    createAnthropicMessages(
                        anthropicPayload,
                        up,
                        {
                            requestType: 'ResponsesWSViaAnthropic',
                            stream: true,
                            originalModel: payload.model,
                            ...stateRelayMeta
                        },
                        getAnthropicRequestHeaders(req)
                    )
                );
            }
        });
        chatReq = invocation.chatRequest;
        const {response} = invocation.result;

        const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
        const sourceChatAccumulator = createChatStreamAccumulator({model: payload.model});
        const responsesAccumulator = createResponsesStreamAccumulator({model: payload.model});
        let completedResponse = null;
        for await (const chatChunk of streamAnthropicSSEToChatChunks(response.body, parseSSEBlock, signal)) {
            if (signal?.aborted) break;
            sourceChatAccumulator.feed(chatChunk);
            const events = chatToResponsesBridge.feed(chatChunk);
            for (const ev of events) {
                responsesAccumulator.feed(ev.event, ev.data);
                if (ev.event === 'response.completed') {
                    completedResponse = ev.data?.response || completedResponse;
                    const sourceChatResponse = sourceChatAccumulator.toChatResponse();
                    recordCompletedResponseState(
                        tenantId,
                        stateConversationKey,
                        completedResponse,
                        sourceChatResponse
                            ? canonicalFromAnthropicStreamChatResponse(sourceChatResponse, {
                                tenantId,
                                conversationKey: stateConversationKey
                            })
                            : null
                    );
                }
                yield {type: ev.event, data: ev.data};
            }
        }
        if (!completedResponse) {
            const sourceChatResponse = sourceChatAccumulator.toChatResponse();
            recordCompletedResponseState(
                tenantId,
                stateConversationKey,
                responsesAccumulator.toResponsesResponse(),
                sourceChatResponse
                    ? canonicalFromAnthropicStreamChatResponse(sourceChatResponse, {
                        tenantId,
                        conversationKey: stateConversationKey
                    })
                    : null
            );
        }
        return;
    }

    // Responses WS 上游：直�?WS 连接上游，转发事�?
    if (isResponsesWebSocketUpstream(upstream)) {
        const wsPayload = {...payload, model: resolvedModel};
        const prepared = relayConversationStore.prepareResponsesPassthrough({
            tenantId,
            conversationKey,
            request: wsPayload
        });
        const stateConversationKey = prepared.conversationKey || conversationKey;
        const limitedRequest = limitResponsesPassthroughPayload(prepared.request, {
            previousResponseId: prepared.lastResponseId,
            requestType: 'RelayResponsesWebSocketRelay',
            conversationKey: stateConversationKey
        });
        const wsResult = await createResponsesWebSocket(limitedRequest, upstream, {
            requestType: 'RelayResponsesWebSocketRelay',
            stream: true,
            originalModel: payload.model,
            contextKey: stateConversationKey,
            sessionId: stateConversationKey,
            rejectUnauthorized: !upstream.skip_tls_verify,
            autoLink: false,
            ...tenantMeta
        });

        // 必须�?finally 释放连接：WS server 在收�?response.completed 后会 break�?        // 触发 generator return()，try 块尾部的 release 永远到不了，连接将一�?busy 烂在池里
        let connHandled = false;
        const responsesAccumulator = createResponsesStreamAccumulator({model: payload.model});
        let completedResponse = null;
        try {
            for await (const event of wsResult.eventStream) {
                if (signal?.aborted) {
                    discardResponsesWebSocketConnection(wsResult.conn);
                    connHandled = true;
                    return;
                }
                responsesAccumulator.feed(event.type, event.data);
                if (event.type === 'response.completed') {
                    completedResponse = event.data?.response || completedResponse;
                    recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
                }
                yield event;
            }
            if (!completedResponse) {
                recordCompletedResponseState(
                    tenantId,
                    stateConversationKey,
                    responsesAccumulator.toResponsesResponse()
                );
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

    // Responses HTTP 上游：透传 SSE �?WS 事件
    if (isResponsesUpstream(upstream)) {
        // stream: WS 客户端不�?stream 字段，但 HTTP 上游需�?stream=true 才返�?SSE
        // store: 火山引擎需�?store=true 才存�?response，否�?previous_response_id 找不�?
        const responsesPayload = {...payload, model: resolvedModel, stream: true, store: true};
        const prepared = relayConversationStore.prepareResponsesPassthrough({
            tenantId,
            conversationKey,
            request: responsesPayload
        });
        const stateConversationKey = prepared.conversationKey || conversationKey;
        const limitedRequest = limitResponsesPassthroughPayload(prepared.request, {
            previousResponseId: prepared.lastResponseId,
            requestType: 'ResponsesWS',
            conversationKey: stateConversationKey
        });
        const {response} = await callUpstream(upstream, (up) =>
            createResponses(limitedRequest, up, {
                requestType: 'ResponsesWS',
                stream: true,
                originalModel: payload.model,
                ...relayMeta,
                conversationKey: stateConversationKey
            })
        );

        const responsesAccumulator = createResponsesStreamAccumulator({model: payload.model});
        let completedResponse = null;
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
                const eventType = getSSEEventType(event, parsed);
                responsesAccumulator.feed(eventType, parsed);
                if (eventType === 'response.completed') {
                    completedResponse = parsed.response || completedResponse;
                    recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
                }
                yield {type: eventType, data: parsed};
            }
        }
        if (!completedResponse) {
            recordCompletedResponseState(
                tenantId,
                stateConversationKey,
                responsesAccumulator.toResponsesResponse()
            );
        }
        return;
    }

    // OpenAI Chat 上游：Chat �?Responses 事件转换
    let hydrated;
    try {
        hydrated = relayConversationStore.hydrateResponsesForFullHistory({
            tenantId,
            conversationKey,
            request: {...payload, model: resolvedModel}
        });
    } catch (error) {
        if (error instanceof RelayStateMissingError) throw toResponsesWebSocketStateMissingError(error);
        throw error;
    }
    let chatReq = hydrated.chatRequest;
    chatReq.stream = true;
    const stateConversationKey = hydrated.conversationKey || conversationKey;
    const stateRelayMeta = {...relayMeta, conversationKey: stateConversationKey};
    const invocation = await invokeWithRelayContextCompaction({
        chatRequest: chatReq,
        compactOptions: {
            upstream,
            upstreamManager,
            tenantId,
            tenantMeta,
            conversationKey: stateConversationKey,
            originalModel: payload.model,
            requestType: 'ResponsesWSViaChat',
            req
        },
        invoke: (readyChatReq) => callUpstream(upstream, (up) =>
            createChatCompletions(prepareRelayOutboundChatRequest(readyChatReq, {
                model: resolvedModel,
                stream: true
            }), up, {
                requestType: 'ResponsesWS',
                stream: true,
                originalModel: payload.model,
                ...stateRelayMeta
            })
        )
    });
    chatReq = invocation.chatRequest;
    const {response} = invocation.result;

    const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
    const responsesAccumulator = createResponsesStreamAccumulator({model: payload.model});
    let completedResponse = null;
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
                responsesAccumulator.feed(ev.event, ev.data);
                if (ev.event === 'response.completed') {
                    completedResponse = ev.data?.response || completedResponse;
                    recordCompletedResponseState(tenantId, stateConversationKey, completedResponse);
                }
                yield {type: ev.event, data: ev.data};
            }
        }
        if (start > 0) buffer = buffer.subarray(start);
    }
    if (!completedResponse) {
        recordCompletedResponseState(
            tenantId,
            stateConversationKey,
            responsesAccumulator.toResponsesResponse()
        );
    }
}

/**
 * 处理 Relay Responses API WebSocket 连接
 * 客户端通过 WS 连接 /relay/v1/responses，发送标�?Responses API WS 协议
 *
 * 注意：鉴权已�?server.js �?upgrade handler 中完成，
 * 并通过 req.tenantId 注入到这里�?
 *
 * @param {import('ws').WebSocket} clientWs - 客户�?WebSocket 连接
 * @param {import('http').IncomingMessage} req - 原始 HTTP 请求（已注入 tenantId�?
 */
export async function handleRelayResponsesWS(clientWs, req) {
    const tenantId = req.tenantId;
    const upstreamManager = await unifiedTenantManager.getUpstreamManager(tenantId);
    req.relayClientConnectionId = req.relayClientConnectionId || `relay-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            if (!upstreamManager) {
                throw Object.assign(new Error('Tenant upstream manager not found'), {
                    name: 'ResponsesWebSocketError',
                    event: {type: 'error', error: {message: 'Tenant upstream manager not found', code: 'server_error'}}
                });
            }

            // Refresh active upstream on every request so switching upstreams takes effect immediately.
            const upstream = upstreamManager.getActiveUpstream();
            if (!upstream) {
                throw Object.assign(new Error('No available upstream configured'), {
                    name: 'ResponsesWebSocketError',
                    event: {type: 'error', error: {message: 'No available upstream configured. Please configure one in /relayFE.', code: 'no_upstream'}}
                });
            }

            const tenant = await unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            req.relayResolvedModel = upstreamManager.resolveModel(payload.model, upstream.index);

            yield* _relayWSHandleRequest(payload, upstream, upstreamManager, tenantId, tenantMeta, signal, req);
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            recordUsage(
                req.tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                req.relayResolvedModel || model
            );
        }
    });
}

/* ==================== 主路�?==================== */

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
                    diagnostics: 'GET /relay/v1/diagnostics - Relay session diagnostics',
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

    if (pathname === '/relay/v1/diagnostics' && method === 'GET') {
        if (!req.tenantId) {
            sendOpenAIError(res, 401, 'Unauthorized', 'authentication_error');
            return;
        }
        sendJson(res, 200, getRelayConversationDiagnostics(relayConversationStore, {tenantId: req.tenantId}));
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
