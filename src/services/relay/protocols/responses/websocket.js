export function createRelayResponsesWebSocketHandler({
    authenticateAndGetUpstream,
    tenantDirectory,
    handleWSConnection,
    recordUsage,
    extractConversationKey,
    isAnthropicUpstream,
    isResponsesWebSocketUpstream,
    isResponsesUpstream,
    relayConversationStore,
    RelayStateMissingError,
    toResponsesWebSocketStateMissingError,
    invokeWithRelayContextCompaction,
    prepareRelayOutboundChatRequest,
    chatRequestToAnthropic,
    callUpstream,
    createAnthropicMessages,
    getAnthropicRequestHeaders,
    createAnthropicToResponsesStreamBridge,
    createChatToResponsesStreamBridge,
    createChatStreamAccumulator,
    createResponsesStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    renderCanonicalToAnthropic,
    recordCompletedResponseState,
    prepareResponsesContinuationPayload,
    createResponsesWebSocket,
    discardResponsesWebSocketConnection,
    releaseResponsesWebSocketConnection,
    createResponses,
    getSSEEventType,
    createChatCompletions
}) {
    async function* relayWSHandleRequest(payload, upstream, upstreamManager, tenantId, tenantMeta, signal, req) {
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
            ensureChatMessagesForResponsesWebSocketFallback({
                chatRequest: chatReq,
                payload,
                targetProtocol: 'anthropic',
                RelayStateMissingError,
                toResponsesWebSocketStateMissingError
            });
            const stateConversationKey = hydrated.conversationKey || conversationKey;
            const stateRelayMeta = {...relayMeta, conversationKey: stateConversationKey};
            const relayAnthropicRequest = sanitizeRelayAnthropicRequest(payload.x_relay_anthropic_request);
            const relayThinkingConfig = sanitizeRelayAnthropicThinkingConfig(payload.x_relay_anthropic_thinking_config);
            const signedCanonicalSession = canonicalSessionHasRelayAnthropicThinking(hydrated.canonicalSession)
                ? hydrated.canonicalSession
                : null;
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
                    const anthropicPayload = signedCanonicalSession && renderCanonicalToAnthropic
                        ? canonicalSessionToAnthropicPayload({
                            session: signedCanonicalSession,
                            outboundChatReq,
                            resolvedModel,
                            relayAnthropicRequest,
                            relayThinkingConfig,
                            renderCanonicalToAnthropic
                        })
                        : chatRequestToAnthropic(outboundChatReq);
                    if (!signedCanonicalSession) {
                        applyAnthropicPayloadControls(anthropicPayload, {
                            relayAnthropicRequest,
                            relayThinkingConfig,
                            outboundChatReq
                        });
                    }
                    ensureAnthropicMessagesForResponsesWebSocketFallback({
                        anthropicPayload,
                        payload,
                        RelayStateMissingError,
                        toResponsesWebSocketStateMissingError
                    });
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

            if (createAnthropicToResponsesStreamBridge) {
                const anthropicToResponsesBridge = createAnthropicToResponsesStreamBridge({model: payload.model});
                const responsesAccumulator = createResponsesStreamAccumulator({model: payload.model});
                let completedResponse = null;
                for await (const event of streamAnthropicSSEToResponsesWSEvents({
                    stream: response.body,
                    parseSSEBlock,
                    bridge: anthropicToResponsesBridge,
                    signal
                })) {
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
                return;
            }

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

        if (isResponsesWebSocketUpstream(upstream)) {
            const wsPayload = stripRelayResponsesPrivateFields({...payload, model: resolvedModel});
            const continuation = prepareResponsesContinuationPayload({
                conversationStore: relayConversationStore,
                tenantId,
                conversationKey,
                request: wsPayload,
                requestType: 'RelayResponsesWebSocketRelay',
                disableContinuation: upstream.disable_responses_continuation === true
            });
            const stateConversationKey = continuation.conversationKey || conversationKey;
            const wsResult = await createResponsesWebSocket(continuation.request, upstream, {
                requestType: 'RelayResponsesWebSocketRelay',
                stream: true,
                originalModel: payload.model,
                contextKey: stateConversationKey,
                sessionId: stateConversationKey,
                rejectUnauthorized: !upstream.skip_tls_verify,
                autoLink: false,
                skipInputItemLimit: upstream.disable_responses_continuation === true || continuation.skipInputItemLimit === true,
                ...tenantMeta
            });

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

        if (isResponsesUpstream(upstream)) {
            const responsesPayload = stripRelayResponsesPrivateFields({
                ...payload,
                model: resolvedModel,
                stream: true,
                store: payload.store ?? true
            });
            const continuation = prepareResponsesContinuationPayload({
                conversationStore: relayConversationStore,
                tenantId,
                conversationKey,
                request: responsesPayload,
                requestType: 'ResponsesWS',
                disableContinuation: upstream.disable_responses_continuation === true
            });
            const stateConversationKey = continuation.conversationKey || conversationKey;
            const {response} = await callUpstream(upstream, (up) =>
                createResponses(continuation.request, up, {
                    requestType: 'ResponsesWS',
                    stream: true,
                    originalModel: payload.model,
                    ...relayMeta,
                    conversationKey: stateConversationKey,
                    skipInputItemLimit: upstream.disable_responses_continuation === true || continuation.skipInputItemLimit === true
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
        ensureChatMessagesForResponsesWebSocketFallback({
            chatRequest: chatReq,
            payload,
            targetProtocol: 'chat',
            RelayStateMissingError,
            toResponsesWebSocketStateMissingError
        });
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
            invoke: (readyChatReq) => {
                const outboundChatReq = prepareRelayOutboundChatRequest(readyChatReq, {
                    model: resolvedModel,
                    stream: true
                });
                ensureChatMessagesForResponsesWebSocketFallback({
                    chatRequest: outboundChatReq,
                    payload,
                    targetProtocol: 'chat',
                    RelayStateMissingError,
                    toResponsesWebSocketStateMissingError
                });
                return callUpstream(upstream, (up) =>
                    createChatCompletions(outboundChatReq, up, {
                        requestType: 'ResponsesWS',
                        stream: true,
                        originalModel: payload.model,
                        ...stateRelayMeta
                    })
                );
            }
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

    return async function handleRelayResponsesWS(clientWs, req) {
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

                const {upstream, tenantId, upstreamManager} = upstreamContext;

                const tenant = await tenantDirectory.getTenant(tenantId);
                const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
                req.relayResolvedModel = upstreamManager.resolveModel(payload.model, upstream.index);

                yield* relayWSHandleRequest(payload, upstream, upstreamManager, tenantId, tenantMeta, signal, req);
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
    };
}

function canonicalSessionHasRelayAnthropicThinking(session) {
    return (session?.turns || []).some((turn) =>
        (turn?.blocks || []).some((block) =>
            block?.type === 'redacted_thinking'
            || (block?.type === 'reasoning' && block.signature)
        )
    );
}

async function* streamAnthropicSSEToResponsesWSEvents({
    stream,
    parseSSEBlock,
    bridge,
    signal
}) {
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
            const eventName = event || parsed?.type;
            for (const rendered of bridge.feed(eventName, parsed)) {
                yield {type: rendered.event, data: rendered.data};
            }
        }
    }

    for (const rendered of bridge.finish?.() || []) {
        yield {type: rendered.event, data: rendered.data};
    }
}

function canonicalSessionToAnthropicPayload({
    session,
    outboundChatReq,
    resolvedModel,
    relayAnthropicRequest,
    relayThinkingConfig,
    renderCanonicalToAnthropic
}) {
    const anthropicPayload = {
        ...renderCanonicalToAnthropic(session),
        model: resolvedModel,
        max_tokens: outboundChatReq.max_tokens || outboundChatReq.max_completion_tokens || 4096,
        stream: outboundChatReq.stream,
        temperature: outboundChatReq.temperature,
        top_p: outboundChatReq.top_p
    };
    applyAnthropicPayloadControls(anthropicPayload, {
        relayAnthropicRequest,
        relayThinkingConfig,
        outboundChatReq
    });
    if (!anthropicPayload.tools || anthropicPayload.tools.length === 0) delete anthropicPayload.tools;
    if (!anthropicPayload.tool_choice) delete anthropicPayload.tool_choice;
    return anthropicPayload;
}

function applyAnthropicPayloadControls(payload, {
    relayAnthropicRequest,
    relayThinkingConfig,
    outboundChatReq
}) {
    applyRelayAnthropicRequest(payload, relayAnthropicRequest);
    if (!payload.stop_sequences && outboundChatReq.stop) {
        payload.stop_sequences = Array.isArray(outboundChatReq.stop)
            ? outboundChatReq.stop
            : [outboundChatReq.stop];
    }
    const reasoningEffort = outboundChatReq.reasoning_effort || payload.reasoning?.effort;
    const thinkingConfig = relayThinkingConfig
        || anthropicThinkingConfigFromReasoningEffort(reasoningEffort, payload.max_tokens);
    if (thinkingConfig) payload.thinking = thinkingConfig;
    delete payload.reasoning;
}

const RELAY_ANTHROPIC_REQUEST_FIELDS = [
    'system',
    'top_k',
    'stop_sequences',
    'metadata',
    'tools',
    'tool_choice',
    'container',
    'context_management',
    'service_tier',
    'mcp_servers'
];

function sanitizeRelayAnthropicRequest(request) {
    if (!request || typeof request !== 'object') return undefined;
    const relay = {};
    for (const field of RELAY_ANTHROPIC_REQUEST_FIELDS) {
        if (request[field] !== undefined) {
            relay[field] = cloneJson(request[field]);
        }
    }
    return Object.keys(relay).length > 0 ? relay : undefined;
}

function applyRelayAnthropicRequest(payload, relayAnthropicRequest) {
    if (!relayAnthropicRequest) return;
    for (const field of RELAY_ANTHROPIC_REQUEST_FIELDS) {
        if (relayAnthropicRequest[field] !== undefined) {
            payload[field] = cloneJson(relayAnthropicRequest[field]);
        }
    }
}

function sanitizeRelayAnthropicThinkingConfig(thinking) {
    if (!thinking || typeof thinking !== 'object') return undefined;
    if (thinking.type === 'enabled') {
        return {
            type: 'enabled',
            ...(Number.isFinite(thinking.budget_tokens) ? {budget_tokens: thinking.budget_tokens} : {})
        };
    }
    if (thinking.type === 'disabled') return {type: 'disabled'};
    if (thinking.type === 'adaptive') return {type: 'adaptive'};
    return undefined;
}

function anthropicThinkingConfigFromReasoningEffort(effort, maxTokens) {
    if (!effort) return undefined;
    if (effort === 'minimal') return {type: 'disabled'};
    const max = Number.isFinite(maxTokens) ? maxTokens : 4096;
    const defaultBudget = effort === 'low' ? 1024 : effort === 'medium' ? 4096 : 8192;
    return {
        type: 'enabled',
        budget_tokens: Math.max(1024, Math.min(defaultBudget, Math.max(max - 1, 1024)))
    };
}

function stripRelayResponsesPrivateFields(payload) {
    if (Array.isArray(payload)) return payload.map(stripRelayResponsesPrivateFields);
    if (!payload || typeof payload !== 'object') return payload;
    const result = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key.startsWith('x_relay_')) continue;
        result[key] = stripRelayResponsesPrivateFields(value);
    }
    return result;
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureChatMessagesForResponsesWebSocketFallback({
    chatRequest,
    payload,
    targetProtocol,
    RelayStateMissingError,
    toResponsesWebSocketStateMissingError
}) {
    if (hasChatConversationAnchorMessage(chatRequest?.messages)) return;
    throw createResponsesWebSocketStateMissingError({
        payload,
        targetProtocol,
        RelayStateMissingError,
        toResponsesWebSocketStateMissingError
    });
}

function hasChatConversationAnchorMessage(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) => {
        const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
        return role === 'user' || role === 'assistant';
    });
}

function ensureAnthropicMessagesForResponsesWebSocketFallback({
    anthropicPayload,
    payload,
    RelayStateMissingError,
    toResponsesWebSocketStateMissingError
}) {
    if (Array.isArray(anthropicPayload?.messages) && anthropicPayload.messages.length > 0) return;
    throw createResponsesWebSocketStateMissingError({
        payload,
        targetProtocol: 'anthropic',
        RelayStateMissingError,
        toResponsesWebSocketStateMissingError
    });
}

function createResponsesWebSocketStateMissingError({
    payload,
    targetProtocol,
    RelayStateMissingError,
    toResponsesWebSocketStateMissingError
}) {
    const previousResponseId = typeof payload?.previous_response_id === 'string' && payload.previous_response_id.trim()
        ? payload.previous_response_id.trim()
        : 'none';
    const error = new RelayStateMissingError(previousResponseId);
    error.message = `Missing relay conversation state for Responses WebSocket ${targetProtocol} request; full-history conversation messages are empty`;
    return toResponsesWebSocketStateMissingError(error);
}
