import {parseUpstreamJson as parseRelayUpstreamJson} from '../../../shared/upstream-json.js';

export function createRelayResponsesAPIHandler({
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
    tenantDirectory,
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
    prepareResponsesContinuationPayload,
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
    RelayStateMissingError = class RelayStateMissingError extends Error {},
    isResponsesWebSocketProtocolError = () => false,
    logger = console
}) {
    return async function handleResponsesAPI(req, res) {
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
                ensureChatMessagesForResponsesFallback({
                    chatRequest: chatReq,
                    request: responsesReq,
                    targetProtocol: 'anthropic',
                    RelayStateMissingError
                });
                const tenant = await tenantDirectory.getTenant(tenantId);
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
                        ensureAnthropicMessagesForResponsesFallback({
                            anthropicPayload,
                            request: responsesReq,
                            RelayStateMissingError
                        });
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
                const parsed = parseRelayUpstreamJson(responseBody);
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
                const tenant = await tenantDirectory.getTenant(tenantId);
                const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
                const wsPayload = {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, upstream.index)};
                const conversationKey = extractConversationKey(req, wsPayload, {tenantId});
                const continuation = prepareResponsesContinuationPayload({
                    conversationStore: relayConversationStore,
                    tenantId,
                    conversationKey,
                    request: wsPayload,
                    requestType: 'ResponsesWebSocketPassthrough',
                    disableContinuation: upstream.disable_responses_continuation === true
                });
                const stateConversationKey = continuation.conversationKey || conversationKey;
                const wsResult = await createResponsesWebSocket(continuation.request, upstream, {
                    requestType: 'ResponsesWebSocket',
                    stream: responsesReq.stream,
                    originalModel: responsesReq.model,
                    contextKey: stateConversationKey,
                    sessionId: stateConversationKey,
                    rejectUnauthorized: !upstream.skip_tls_verify,
                    autoLink: false,
                    skipInputItemLimit: upstream.disable_responses_continuation === true || continuation.skipInputItemLimit === true,
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
                const tenant = await tenantDirectory.getTenant(tenantId);
                const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
                const conversationKey = extractConversationKey(req, responsesReq, {tenantId});
                const responsesPayload = {...responsesReq, model: upstreamManager.resolveModel(responsesReq.model, upstream.index)};
                const continuation = prepareResponsesContinuationPayload({
                    conversationStore: relayConversationStore,
                    tenantId,
                    conversationKey,
                    request: responsesPayload,
                    requestType: 'ResponsesPassthrough',
                    disableContinuation: upstream.disable_responses_continuation === true
                });
                const stateConversationKey = continuation.conversationKey || conversationKey;
                const relayMeta = {
                    ...tenantMeta,
                    conversationKey: stateConversationKey,
                    sessionId: stateConversationKey
                };
                const {response} = await callUpstream(upstream, (up) =>
                    createResponses(
                        {...continuation.request, model: upstreamManager.resolveModel(responsesReq.model, up.index)},
                        up,
                        {
                            requestType: 'ResponsesPassthrough',
                            stream: responsesReq.stream,
                            originalModel: responsesReq.model,
                            skipInputItemLimit: upstream.disable_responses_continuation === true || continuation.skipInputItemLimit === true,
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
                const parsed = parseRelayUpstreamJson(responseBody);
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

            const responsesConversationKey = extractConversationKey(req, responsesReq, {tenantId});
            const hydrated = relayConversationStore.hydrateResponsesForFullHistory({
                tenantId,
                conversationKey: responsesConversationKey,
                request: responsesReq
            });
            let chatReq = hydrated.chatRequest;
            ensureChatMessagesForResponsesFallback({
                chatRequest: chatReq,
                request: responsesReq,
                targetProtocol: 'chat',
                RelayStateMissingError
            });

            const tenant = await tenantDirectory.getTenant(tenantId);
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
                        ensureChatMessagesForResponsesFallback({
                            chatRequest: payload,
                            request: responsesReq,
                            targetProtocol: 'chat',
                            RelayStateMissingError
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
                const invocation = await invokeWithRelayContextCompaction({
                    chatRequest: chatReq,
                    compactOptions,
                    invoke: (readyChatReq) => callUpstream(upstream, (up) => {
                        const payload = prepareRelayOutboundChatRequest(readyChatReq, {
                            model: upstreamManager.resolveModel(readyChatReq.model, up.index),
                            stream: true
                        });
                        ensureChatMessagesForResponsesFallback({
                            chatRequest: payload,
                            request: responsesReq,
                            targetProtocol: 'chat',
                            RelayStateMissingError
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
    };
}

function ensureChatMessagesForResponsesFallback({
    chatRequest,
    request,
    targetProtocol,
    RelayStateMissingError
}) {
    if (hasChatConversationAnchorMessage(chatRequest?.messages)) return;
    throw createResponsesStateMissingError({request, targetProtocol, RelayStateMissingError});
}

function hasChatConversationAnchorMessage(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) => {
        const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : '';
        return role === 'user' || role === 'assistant';
    });
}

function ensureAnthropicMessagesForResponsesFallback({
    anthropicPayload,
    request,
    RelayStateMissingError
}) {
    if (Array.isArray(anthropicPayload?.messages) && anthropicPayload.messages.length > 0) return;
    throw createResponsesStateMissingError({request, targetProtocol: 'anthropic', RelayStateMissingError});
}

function createResponsesStateMissingError({request, targetProtocol, RelayStateMissingError}) {
    const previousResponseId = typeof request?.previous_response_id === 'string' && request.previous_response_id.trim()
        ? request.previous_response_id.trim()
        : 'none';
    const error = new RelayStateMissingError(previousResponseId);
    error.message = `Missing relay conversation state for Responses ${targetProtocol} request; full-history conversation messages are empty`;
    return error;
}
