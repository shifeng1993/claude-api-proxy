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
    aggregateStreamResponse
} from '../services/providers/index.js';
import {
    anthropicToOpenAI,
    injectBehaviorRules
} from '../services/relay/anthropic-adapter.js';
import {extractConversationKey} from '../services/relay/conversation-key.js';
import {createRelayUsageRecorder} from '../services/relay/usage.js';
import {
    callRelayUpstream as callUpstream,
    createRelayUpstreamContextResolver,
    getRelayProtocolErrorMessage as getProtocolErrorMessage,
    relayUpstreamErrorStatus as upstreamErrorStatus
} from '../services/relay/upstream-context.js';
import {
    createRelayCompletedResponseRecorder,
    createRelayResponsesPassthroughLimiter,
    createRelayResponsesWebSocketCollector
} from '../services/relay/response-state.js';
import {
    sendRelayAnthropicError as sendAnthropicError,
    sendRelayJsonResponse as sendJson,
    sendRelayOpenAIError as sendOpenAIError,
    sendRelayResponsesWebSocketProtocolError as sendResponsesWebSocketProtocolError,
    sendRelayStateMissingOpenAIError as sendStateMissingOpenAIError,
    toRelayResponsesWebSocketStateMissingError as toResponsesWebSocketStateMissingError
} from '../services/relay/response-writer.js';
import {
    getRelaySSEEventType as getSSEEventType,
    parseRelayResponsesSSEEvents as parseResponsesSSEEvents,
    parseRelaySSEBlock as parseSSEBlock,
    readRelayRequestBody as parseBody,
    readRelayResponseBody as readResponseBody
} from '../services/relay/stream-events.js';
import {
    getAnthropicRequestHeaders,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic
} from '../services/relay/model-metadata.js';
import {createRelayMetadataHandlers} from '../services/relay/metadata-endpoints.js';
import {createRelayChatCompletionsHandler} from '../services/relay/chat-completions-handler.js';
import {createRelayAnthropicMessagesHandler} from '../services/relay/anthropic-messages-handler.js';
import {createRelayResponsesAPIHandler} from '../services/relay/responses-api-handler.js';
import {createRelayResponsesCompactHandler} from '../services/relay/responses-compact-handler.js';
import {prepareRelayOutboundChatRequest} from '../services/relay/outbound-chat.js';
import {createRelayContextCompaction} from '../services/relay/context-compaction.js';
import {
    estimateRelayAnthropicInputTokens as estimateAnthropicInputTokens,
    handleRelayAnthropicUsageEvent as handleAnthropicUsageEvent
} from '../services/relay/anthropic-usage.js';
import {
    streamRelayResponsesEventsAsAnthropic as streamResponsesEventsAsAnthropic,
    writeRelayAnthropicEvent as writeAnthropicEvent
} from '../services/relay/anthropic-stream.js';
import {createRelayOpenAIStreamPassthrough} from '../services/relay/openai-stream.js';
import {
    anthropicResponseToChat,
    rewriteOpenAIStream,
    stripDynamicReminders,
    sanitizeAnthropicPayload,
    extractCacheHitTokens,
    extractInputTokens,
    compactRequestToChat,
    chatResponseToCompact,
    mergeConsecutiveAssistantMessages,
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
import {
    handleWSConnection,
    isResponsesWebSocketProtocolError
} from '../services/shared/index.js';
import {
    RelayStateMissingError,
    relayConversationStore,
    prepareResponsesContinuationPayload
} from '../services/session/index.js';
import logger from '../utils/logger.js';

const {
    recordResponsesUsage,
    recordUsage
} = createRelayUsageRecorder(unifiedTenantManager);
const authenticateAndGetUpstream = createRelayUpstreamContextResolver(unifiedTenantManager);
const recordCompletedResponseState = createRelayCompletedResponseRecorder(relayConversationStore);
const limitResponsesPassthroughPayload = createRelayResponsesPassthroughLimiter({logger});
const collectResponsesWebSocketResponse = createRelayResponsesWebSocketCollector({
    releaseConnection: releaseResponsesWebSocketConnection,
    discardConnection: discardResponsesWebSocketConnection
});
const {invokeWithRelayContextCompaction} = createRelayContextCompaction({
    conversationStore: relayConversationStore,
    logger,
    isAnthropicUpstream,
    chatRequestToAnthropic,
    createAnthropicMessages,
    createChatCompletions,
    callUpstream,
    getAnthropicRequestHeaders,
    readResponseBody,
    anthropicResponseToChat,
    recordUsage,
    extractCacheHitTokens
});
const streamOpenAIPassthrough = createRelayOpenAIStreamPassthrough({
    conversationStore: relayConversationStore,
    recordUsage,
    logger
});
const {
    handleOpenAIModels,
    handleAnthropicModels,
    handleAnthropicCountTokens
} = createRelayMetadataHandlers({
    authenticateAndGetUpstream,
    getUpstreamModels,
    getAnthropicRequestHeaders,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    createAnthropicCountTokens,
    callUpstream,
    readResponseBody,
    parseBody,
    sanitizeAnthropicPayload,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic,
    getProtocolErrorMessage,
    upstreamErrorStatus,
    sendJson,
    sendOpenAIError,
    sendAnthropicError,
    logger
});
const handleOpenAIChatCompletions = createRelayChatCompletionsHandler({
    authenticateAndGetUpstream,
    unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    sendStateMissingOpenAIError,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    extractConversationKey,
    relayConversationStore,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createChatStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordUsage,
    extractCacheHitTokens,
    readResponseBody,
    anthropicResponseToChat,
    chatRequestToAnthropic,
    chatRequestToRelayResponses,
    prepareResponsesContinuationPayload,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createResponsesToChatStreamBridge,
    createResponsesStreamAccumulator,
    collectResponsesWebSocketResponse,
    recordCompletedResponseState,
    recordResponsesUsage,
    responsesResponseToRelayChat,
    createResponses,
    getSSEEventType,
    extractInputTokens,
    createChatCompletions,
    streamOpenAIPassthrough,
    RelayStateMissingError,
    isResponsesWebSocketProtocolError,
    logger
});
const handleAnthropicMessages = createRelayAnthropicMessagesHandler({
    authenticateAndGetUpstream,
    unifiedTenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    anthropicToOpenAI,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    extractConversationKey,
    relayConversationStore,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createAnthropicStreamAccumulator,
    parseSSEBlock,
    handleAnthropicUsageEvent,
    anthropicResponseToChat,
    recordUsage,
    estimateAnthropicInputTokens,
    readResponseBody,
    extractInputTokens,
    extractCacheHitTokens,
    chatRequestToRelayResponses,
    prepareResponsesContinuationPayload,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createResponsesStreamAccumulator,
    streamResponsesEventsAsAnthropic,
    recordCompletedResponseState,
    recordResponsesUsage,
    collectResponsesWebSocketResponse,
    responsesResponseToRelayChat,
    chatResponseToAnthropic,
    createResponses,
    parseResponsesSSEEvents,
    createChatCompletions,
    createChatToAnthropicStreamBridge,
    createChatStreamAccumulator,
    writeAnthropicEvent,
    aggregateStreamResponse,
    logger
});
const handleResponsesAPI = createRelayResponsesAPIHandler({
    authenticateAndGetUpstream,
    sendOpenAIError,
    sendJson,
    sendStateMissingOpenAIError,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    extractConversationKey,
    relayConversationStore,
    unifiedTenantManager,
    invokeWithRelayContextCompaction,
    prepareRelayOutboundChatRequest,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createChatToResponsesStreamBridge,
    createResponsesStreamAccumulator,
    createChatStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordCompletedResponseState,
    recordUsage,
    extractCacheHitTokens,
    readResponseBody,
    anthropicResponseToChat,
    chatResponseToRelayResponses,
    canonicalFromAnthropicResponse,
    createResponsesWebSocket,
    limitResponsesPassthroughPayload,
    createResponsesToResponsesStreamBridge,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    recordResponsesUsage,
    collectResponsesWebSocketResponse,
    createResponses,
    getSSEEventType,
    extractInputTokens,
    createChatCompletions,
    aggregateStreamResponse,
    RelayStateMissingError,
    isResponsesWebSocketProtocolError,
    logger
});

const handleResponsesCompact = createRelayResponsesCompactHandler({
    authenticateAndGetUpstream,
    sendOpenAIError,
    sendJson,
    sendResponsesWebSocketProtocolError,
    upstreamErrorStatus,
    parseBody,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    extractConversationKey,
    unifiedTenantManager,
    compactRequestToChat,
    injectBehaviorRules,
    stripDynamicReminders,
    mergeConsecutiveAssistantMessages,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    readResponseBody,
    anthropicResponseToChat,
    extractCacheHitTokens,
    recordUsage,
    chatResponseToCompact,
    chatRequestToRelayResponses,
    limitResponsesPassthroughPayload,
    createResponsesWebSocket,
    collectResponsesWebSocketResponse,
    recordResponsesUsage,
    responsesResponseToRelayChat,
    createResponses,
    extractInputTokens,
    createChatCompletions,
    aggregateStreamResponse,
    isResponsesWebSocketProtocolError,
    logger
});

/* ==================== 工具函数 ==================== */





/* ==================== 鉴权 ==================== */

/* ==================== 处理函数 ==================== */

/**
 * 处理 OpenAI 格式�?/relay/v1/chat/completions 请求
 */
/**
 * 处理 Anthropic 格式�?/relay/anthropic/v1/messages 请求
 */
/* ==================== 流式响应辅助 ==================== */

/** OpenAI 上游流式透传（OpenAI 端点 �?OpenAI 上游），�?reasoning_content 做缓冲合�?*/
/* ==================== 其他端点 ==================== */

/* ==================== Responses API ==================== */

/**
 * 处理 Responses API 请求 (/relay/v1/responses)
 * �?Responses 格式转为 Chat Completions 发给上游，再将响应转�?Responses 格式
 */
/**
 * 处理 Responses Compact 请求 (/relay/v1/responses/compact)
 */
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
    req.relayClientConnectionId = req.relayClientConnectionId || `relay-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            const upstreamContext = await authenticateAndGetUpstream(req);
            if (upstreamContext.error) {
                throw Object.assign(new Error(upstreamContext.error.message), {
                    name: 'ResponsesWebSocketError',
                    event: {
                        type: 'error',
                        error: {
                            message: upstreamContext.error.message,
                            code: upstreamContext.error.status === 503 ? 'no_upstream' : 'server_error'
                        }
                    }
                });
            }

            // Refresh active upstream on every request so switching upstreams takes effect immediately.
            const {upstream, tenantId, upstreamManager} = upstreamContext;

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
