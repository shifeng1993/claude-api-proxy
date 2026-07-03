function buildChatResponseFromAggregatedResponses(aggregated, fallbackModel) {
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
        usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
    };
}

function writeResponsesSSE(res, event) {
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function warnIfEnterpriseContextMissing({
    credential,
    getCodebuddyBaseUrl,
    isPersonalHost,
    logger
}) {
    if (credential.enterprise_id) return;
    const host = new URL(getCodebuddyBaseUrl(credential.base_url)).host;
    if (!isPersonalHost(host)) {
        logger.warn(
            `[CodeBuddy Responses API]: credential ${credential.user_id} missing enterprise_id; upstream ${host} may reject quota`
        );
    }
}

export function createCodebuddyResponsesAPIHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    getCodebuddyBaseUrl,
    isPersonalHost,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToResponsesStreamBridge,
    aggregateStreamResponse,
    extractCacheHitTokens,
    recordUsage,
    chatResponseToResponses,
    logger = console
}) {
    return async function handleResponsesAPI(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (!authResult.error) {
                const tenant = await tenantManager.getTenant(authResult.tenantId);
                if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
            }
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            warnIfEnterpriseContextMissing({
                credential: authResult.credential,
                getCodebuddyBaseUrl,
                isPersonalHost,
                logger
            });

            const body = await parseBody(req);
            const responsesReq = JSON.parse(body);
            const conversationId = resolveConversationId(req, responsesReq.input, responsesReq, {
                tenantId: authResult.tenantId
            });
            const chatReq = responsesRequestToChat(responsesReq);

            if (chatReq.model) {
                chatReq.model = mapModelName(chatReq.model);
            }

            prepareCodebuddyOutboundChatRequest(chatReq);

            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const response = await createChatCompletions(chatReq, {
                credential: authResult.credential,
                conversationId,
                conversationRequestId: req.headers['x-conversation-request-id'],
                conversationMessageId: req.headers['x-conversation-message-id'],
                requestId: req.headers['x-request-id'],
                ...tenantMeta
            });

            if (responsesReq.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
                let buffer = Buffer.alloc(0);
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                let streamCredit = 0;
                let streamModel = '';

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

                        if (data.usage) {
                            streamInputTokens = data.usage.prompt_tokens || 0;
                            streamOutputTokens = data.usage.completion_tokens || 0;
                            streamCacheHitTokens = extractCacheHitTokens(data.usage);
                            streamCredit = data.usage.credit || 0;
                        }
                        if (data.model) streamModel = data.model;

                        const events = chatToResponsesBridge.feed(data);
                        for (const ev of events) {
                            writeResponsesSSE(res, ev);
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                });

                response.body.on('end', () => {
                    if (!chatToResponsesBridge.finished) {
                        for (const ev of chatToResponsesBridge.finish()) {
                            writeResponsesSSE(res, ev);
                        }
                    }
                    recordUsage(
                        authResult.tenantId,
                        streamInputTokens,
                        streamOutputTokens,
                        streamCacheHitTokens,
                        streamCredit,
                        streamModel,
                        responsesReq.model
                    );
                    res.end();
                });

                response.body.on('error', (err) => {
                    logger.error(`Responses stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                    res.end();
                });
                return;
            }

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
                responsesReq.model
            );

            const chatResponse = buildChatResponseFromAggregatedResponses(aggregated, chatReq.model);
            sendJson(res, 200, chatResponseToResponses(chatResponse));
        } catch (error) {
            logger.error(`Failed to handle Responses API${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
