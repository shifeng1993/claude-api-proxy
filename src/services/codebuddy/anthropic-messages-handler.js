function buildOpenAIResponseForAnthropic(aggregated, fallbackModel) {
    const toolCalls = Array.isArray(aggregated.toolCalls) ? aggregated.toolCalls : [];
    return {
        id: aggregated.id || `msg_${Date.now()}`,
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
                finish_reason: aggregated.finishReason || 'stop',
                logprobs: null
            }
        ],
        usage: aggregated.usage || {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

function writeAnthropicEvent(res, event) {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeStreamErrorAsAnthropicEvents({
    res,
    bridge,
    model,
    error
}) {
    if (bridge.finished || res.destroyed) return;
    const errorChunk = {
        id: 'chatcmpl_error',
        model,
        choices: [{
            delta: {content: `Model request failed, please retry later.\n${error?.message || ''}`},
            finish_reason: 'stop'
        }]
    };
    for (const event of bridge.feed(errorChunk)) {
        if (res.destroyed) break;
        writeAnthropicEvent(res, event);
    }
}

export function createCodebuddyAnthropicMessagesHandler({
    authenticateAndGetCredential,
    tenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    anthropicToOpenAI,
    mapModelName,
    resolveConversationId,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToAnthropicStreamBridge,
    aggregateStreamResponse,
    extractCacheHitTokens,
    openAIToAnthropic,
    recordUsage,
    logger = console
}) {
    return async function handleAnthropicMessages(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await authenticateAndGetCredential(req);
            if (!authResult.error) {
                const tenant = await tenantManager.getTenant(authResult.tenantId);
                if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
            }
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
            const tenant = await tenantManager.getTenant(authResult.tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
            const openAIPayload = anthropicToOpenAI(anthropicPayload);

            if (openAIPayload.model) {
                openAIPayload.model = mapModelName(openAIPayload.model);
            }

            const conversationId = resolveConversationId(req, anthropicPayload.messages, anthropicPayload, {
                tenantId: authResult.tenantId
            });

            prepareCodebuddyOutboundChatRequest(openAIPayload);

            const response = await createChatCompletions(openAIPayload, {
                credential: authResult.credential,
                conversationId,
                conversationRequestId: req.headers['x-conversation-request-id'],
                conversationMessageId: req.headers['x-conversation-message-id'],
                requestId: req.headers['x-request-id'],
                ...tenantMeta
            });

            if (anthropicPayload.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive'
                });

                const chatToAnthropicBridge = createChatToAnthropicStreamBridge({model: anthropicPayload.model});
                let buffer = Buffer.alloc(0);
                let streamInputTokens = 0;
                let streamOutputTokens = 0;
                let streamCacheHitTokens = 0;
                let streamCredit = 0;
                let streamModel = '';
                const responseBody = response.body;

                responseBody.on('data', (chunk) => {
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

                        for (const event of chatToAnthropicBridge.feed(data)) {
                            if (res.destroyed) break;
                            writeAnthropicEvent(res, event);
                        }
                    }

                    if (start > 0) {
                        buffer = buffer.subarray(start);
                    }
                });

                responseBody.on('end', () => {
                    if (!chatToAnthropicBridge.finished) {
                        for (const event of chatToAnthropicBridge.finish()) {
                            if (res.destroyed) break;
                            writeAnthropicEvent(res, event);
                        }
                    }
                    recordUsage(
                        authResult.tenantId,
                        streamInputTokens,
                        streamOutputTokens,
                        streamCacheHitTokens,
                        streamCredit,
                        streamModel,
                        anthropicPayload.model
                    );
                    res.end();
                });

                responseBody.on('error', (err) => {
                    logger.error(`Stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                    writeStreamErrorAsAnthropicEvents({
                        res,
                        bridge: chatToAnthropicBridge,
                        model: streamModel || anthropicPayload.model,
                        error: err
                    });
                    res.end();
                });
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
                anthropicPayload.model
            );

            const openAIResponse = buildOpenAIResponseForAnthropic(aggregated, openAIPayload.model);
            sendJson(res, 200, openAIToAnthropic(openAIResponse));
        } catch (error) {
            logger.error(`Failed to handle Anthropic messages${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
