export function createRelayAnthropicMessagesHandler({
    authenticateAndGetUpstream,
    tenantDirectory,
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
    logger = console
}) {
    return async function handleAnthropicMessages(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetUpstream(req);
            if (!authResult.error) {
                const tenant = await tenantDirectory.getTenant(authResult.tenantId);
                if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
            }
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const {upstream, tenantId, upstreamManager} = authResult;
            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
            const tenant = await tenantDirectory.getTenant(tenantId);
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
                try { res.end(); } catch {}
            }
        }
    };
}
