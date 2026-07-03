export function buildCodebuddyChatCompletionResponse(aggregated, fallbackModel) {
    const toolCalls = Array.isArray(aggregated.toolCalls) ? aggregated.toolCalls : [];
    return {
        id: aggregated.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: aggregated.model || fallbackModel,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: aggregated.content || null,
                    reasoning_content: aggregated.reasoningContent || undefined,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                },
                finish_reason: aggregated.finishReason || 'stop'
            }
        ],
        usage: aggregated.usage || {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

export function createCodebuddyChatCompletionsHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    mapModelName,
    resolveConversationId,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    rewriteOpenAIStream,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage,
    logger = console
}) {
    return async function handleOpenAIChatCompletions(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (!authResult.error) {
                const tenant = await tenantManager.getTenant(authResult.tenantId);
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

            const body = await parseBody(req);
            const openAIPayload = JSON.parse(body);

            if (openAIPayload.model) {
                openAIPayload.model = mapModelName(openAIPayload.model);
            }

            const conversationId = resolveConversationId(req, openAIPayload.messages, openAIPayload, {
                tenantId: authResult.tenantId
            });

            prepareCodebuddyOutboundChatRequest(openAIPayload);

            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

            const response = await createChatCompletions(openAIPayload, {
                credential: authResult.credential,
                conversationId,
                conversationRequestId: req.headers['x-conversation-request-id'],
                conversationMessageId: req.headers['x-conversation-message-id'],
                requestId: req.headers['x-request-id'],
                ...tenantMeta
            });

            if (openAIPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                rewriteOpenAIStream(
                    res,
                    response.body,
                    (inputTokens, outputTokens, cacheHitTokens, credit, model) => {
                        recordUsage(
                            authResult.tenantId,
                            inputTokens,
                            outputTokens,
                            cacheHitTokens,
                            credit,
                            model,
                            openAIPayload.model
                        );
                    },
                    undefined,
                    {logger}
                );
                return;
            }

            const aggregated = await aggregateStreamResponse(response.body);
            const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
            const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
            recordUsage(
                authResult.tenantId,
                inputTokens,
                outputTokens,
                cacheHitTokens,
                credit,
                aggregated.model,
                openAIPayload.model
            );

            sendJson(res, 200, buildCodebuddyChatCompletionResponse(aggregated, openAIPayload.model));
        } catch (error) {
            logger.error(`Failed to handle OpenAI chat completions${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
