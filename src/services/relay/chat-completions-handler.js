export function createRelayChatCompletionsHandler({
    authenticateAndGetUpstream,
    tenantDirectory,
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
    RelayStateMissingError = class RelayStateMissingError extends Error {},
    isResponsesWebSocketProtocolError = () => false,
    logger = console
}) {
    return async function handleOpenAIChatCompletions(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetUpstream(req);
            if (!authResult.error) {
                const tenant = await tenantDirectory.getTenant(authResult.tenantId);
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

            const tenant = await tenantDirectory.getTenant(tenantId);
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
                streamOpenAIPassthrough(response, res, tenantId, tenantInfo, relayStatsModel, conversationKey);
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
    };
}
