function buildChatResponseFromAggregatedCompact(aggregated, fallbackModel) {
    return {
        id: aggregated.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aggregated.model || fallbackModel,
        choices: [
            {
                index: 0,
                message: {role: 'assistant', content: aggregated.content || null},
                finish_reason: aggregated.finishReason || 'stop'
            }
        ],
        usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
    };
}

export function createCodebuddyResponsesCompactHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    resolveConversationId,
    compactRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage,
    chatResponseToCompact,
    logger = console
}) {
    return async function handleResponsesCompact(req, res) {
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const compactReq = JSON.parse(body);
            const conversationId = resolveConversationId(req, compactReq.input, compactReq, {
                tenantId: authResult.tenantId
            });
            const chatReq = compactRequestToChat(compactReq);

            if (chatReq.model) {
                chatReq.model = mapModelName(chatReq.model);
            }

            prepareCodebuddyOutboundChatRequest(chatReq);

            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const response = await createChatCompletions(chatReq, {
                credential: authResult.credential,
                conversationId,
                ...tenantMeta
            });

            const aggregated = await aggregateStreamResponse(response.body);
            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage?.credit || 0;
            recordUsage(
                authResult.tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                credit,
                aggregated.model,
                compactReq.model
            );

            const chatResponse = buildChatResponseFromAggregatedCompact(aggregated, chatReq.model);
            sendJson(res, 200, chatResponseToCompact(chatResponse));
        } catch (error) {
            logger.error('Failed to handle Responses Compact:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
