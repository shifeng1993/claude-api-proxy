export function createCopilotResponsesCompactHandler({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    compactRequestToChat,
    createChatCompletions,
    copilotState,
    readBody,
    extractCacheHitTokens,
    copilotStore,
    chatResponseToCompact,
    logger = console
}) {
    return async function handleResponsesCompact(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const compactReq = JSON.parse(body);
            const chatReq = compactRequestToChat(compactReq);

            const response = await createChatCompletions(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                chatReq,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            if (response.status >= 400) {
                const errorBody = await readBody(response.body);
                sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                return;
            }

            const responseBody = await readBody(response.body);
            const chatResponse = JSON.parse(responseBody);
            const inputTokens = chatResponse.usage?.prompt_tokens || 0;
            const outputTokens = chatResponse.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
            copilotStore.incrementApiCallCount();
            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);

            sendJson(res, 200, chatResponseToCompact(chatResponse));
        } catch (error) {
            logger.error('Copilot: Failed to handle Responses Compact:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
