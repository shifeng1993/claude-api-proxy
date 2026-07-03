import {parseUpstreamJson as parseRelayUpstreamJson} from '../../../shared/upstream-json.js';

export function createRelayResponsesCompactHandler({
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
    tenantDirectory,
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
    isResponsesWebSocketProtocolError = () => false,
    logger = console
}) {
    return async function handleResponsesCompact(req, res) {
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
                const tenant = await tenantDirectory.getTenant(tenantId);
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
                const parsed = parseRelayUpstreamJson(responseBody);
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
                const tenant = await tenantDirectory.getTenant(tenantId);
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
                const tenant = await tenantDirectory.getTenant(tenantId);
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
                const parsed = parseRelayUpstreamJson(responseBody);
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

            const tenant = await tenantDirectory.getTenant(tenantId);
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
    };
}
