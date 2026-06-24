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
    createChatToResponsesStreamBridge,
    createChatStreamAccumulator,
    createResponsesStreamAccumulator,
    streamAnthropicSSEToChatChunks,
    parseSSEBlock,
    canonicalFromAnthropicStreamChatResponse,
    recordCompletedResponseState,
    limitResponsesPassthroughPayload,
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
