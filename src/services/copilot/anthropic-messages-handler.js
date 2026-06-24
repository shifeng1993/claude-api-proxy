export function createCopilotAnthropicMessagesHandler({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    extractConversationKey,
    anthropicToResponses,
    ensureResponsesWebSocketSupported,
    createResponsesWS,
    copilotState,
    createResponsesToAnthropicStreamBridge,
    convertResponsesUsageToChat,
    extractCacheHitTokens,
    releaseWSConnection,
    discardWSConnection,
    responsesResponseToChat,
    openAIToAnthropic,
    copilotStore,
    estimateMessageTokens,
    anthropicToOpenAI,
    createChatCompletions,
    readBody,
    createChatToAnthropicStreamBridge,
    logger = console
}) {
    return async function handleAnthropicMessages(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

            logger.info(`Copilot Anthropic request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

            const conversationKey = extractConversationKey(req, anthropicPayload);
            const responsesReq = anthropicToResponses(anthropicPayload);

            try {
                ensureResponsesWebSocketSupported(responsesReq.model);
                const wsResult = await createResponsesWS(
                    authResult.copilotToken,
                    copilotState.vsCodeVersion,
                    responsesReq,
                    copilotState.accountType,
                    proxyUrl,
                    {contextKey: conversationKey, rejectUnauthorized: networkOptions.rejectUnauthorized}
                );

                if (anthropicPayload.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    const responsesToAnthropicBridge = createResponsesToAnthropicStreamBridge({model: anthropicPayload.model});
                    let streamInputTokens = 0;
                    let streamOutputTokens = 0;
                    let streamCacheHitTokens = 0;
                    try {
                        for await (const event of wsResult.eventStream) {
                            if (event.type === 'response.completed' && event.data?.response?.usage) {
                                const chatUsage = convertResponsesUsageToChat(event.data.response.usage);
                                streamInputTokens = chatUsage.prompt_tokens || 0;
                                streamOutputTokens = chatUsage.completion_tokens || 0;
                                streamCacheHitTokens = extractCacheHitTokens(chatUsage);
                            }
                            const anthropicEvents = responsesToAnthropicBridge.feed(event.type, event.data);
                            for (const ev of anthropicEvents) {
                                if (res.destroyed) break;
                                res.write(`event: ${ev.type}\n`);
                                res.write(`data: ${JSON.stringify(ev)}\n\n`);
                            }
                        }
                        if (!responsesToAnthropicBridge.finished) {
                            for (const ev of responsesToAnthropicBridge.finish()) {
                                if (res.destroyed) break;
                                res.write(`event: ${ev.type}\n`);
                                res.write(`data: ${JSON.stringify(ev)}\n\n`);
                            }
                        }
                        releaseWSConnection(wsResult.conn);
                    } catch (err) {
                        discardWSConnection(wsResult.conn);
                        throw err;
                    }

                    if (streamInputTokens > 0 || streamOutputTokens > 0) {
                        copilotStore.incrementApiCallCount();
                        copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                        copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                    } else {
                        copilotStore.incrementApiCallCount();
                        const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    if (!res.destroyed) res.end();
                } else {
                    let completedData = null;
                    try {
                        for await (const event of wsResult.eventStream) {
                            if (event.type === 'response.completed') {
                                completedData = event.data;
                            }
                        }
                        releaseWSConnection(wsResult.conn);
                    } catch (err) {
                        discardWSConnection(wsResult.conn);
                        throw err;
                    }

                    if (completedData?.response) {
                        const chatResponse = responsesResponseToChat(completedData.response);
                        const anthropicResponse = openAIToAnthropic(chatResponse);
                        const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                        const outputTokens = chatResponse.usage?.completion_tokens || 0;
                        const cacheHitTokens = extractCacheHitTokens(chatResponse.usage);
                        copilotStore.incrementApiCallCount();
                        if (inputTokens > 0 || outputTokens > 0) {
                            copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                            copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                        } else {
                            const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                            copilotStore.incrementTokenUsage(estimated, 0, 0);
                            copilotStore.recordDailyUsage(estimated, 0, 0);
                        }
                        sendJson(res, 200, anthropicResponse);
                    } else {
                        sendAnthropicError(res, 502, 'No response.completed event received from upstream');
                    }
                }
            } catch (wsError) {
                if (res.headersSent) {
                    logger.warn(`Copilot Anthropic: WS stream failed after response started: ${wsError.message}`);
                    if (!res.destroyed && !res.writableEnded) {
                        res.end();
                    }
                    return;
                }

                logger.warn(`Copilot Anthropic: WS failed, falling back to HTTP POST: ${wsError.message}`);

                const openAIPayload = anthropicToOpenAI(anthropicPayload);
                const response = await createChatCompletions(
                    authResult.copilotToken,
                    copilotState.vsCodeVersion,
                    openAIPayload,
                    copilotState.accountType,
                    proxyUrl,
                    networkOptions
                );

                if (response.status >= 400) {
                    const errorBody = await readBody(response.body);
                    sendAnthropicError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
                    return;
                }

                if (anthropicPayload.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        Connection: 'keep-alive'
                    });

                    const chatToAnthropicBridge = createChatToAnthropicStreamBridge({model: anthropicPayload.model});
                    let buffer = '';
                    let streamInputTokens = 0;
                    let streamOutputTokens = 0;
                    let streamCacheHitTokens = 0;
                    const processLines = (lines) => {
                        for (const line of lines) {
                            if (res.destroyed) return;

                            const trimmedLine = line.trim();
                            if (trimmedLine.startsWith('data: ')) {
                                const data = trimmedLine.slice(6);

                                if (data === '[DONE]') {
                                    continue;
                                }

                                try {
                                    const openAIChunk = JSON.parse(data);
                                    const anthropicEvents = chatToAnthropicBridge.feed(openAIChunk);

                                    if (openAIChunk.usage) {
                                        streamInputTokens = openAIChunk.usage.prompt_tokens || streamInputTokens;
                                        streamOutputTokens = openAIChunk.usage.completion_tokens || streamOutputTokens;
                                        streamCacheHitTokens = extractCacheHitTokens(openAIChunk.usage);
                                    }

                                    for (const event of anthropicEvents) {
                                        if (res.destroyed) return;
                                        res.write(`event: ${event.type}\n`);
                                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                                    }
                                } catch (e) {
                                    logger.error('Failed to parse chunk:', e);
                                }
                            }
                        }
                    };

                    response.body.on('data', (chunk) => {
                        try {
                            if (res.destroyed) return;

                            buffer += chunk.toString('utf8');
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            processLines(lines);
                        } catch (error) {
                            logger.error('Stream processing error:', error);
                        }
                    });

                    response.body.on('end', () => {
                        if (buffer.trim()) {
                            try {
                                processLines([buffer]);
                            } catch (error) {
                                logger.error('Failed to process remaining buffer:', error);
                            }
                            buffer = '';
                        }
                        if (!chatToAnthropicBridge.finished) {
                            for (const event of chatToAnthropicBridge.finish()) {
                                if (res.destroyed) return;
                                res.write(`event: ${event.type}\n`);
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                            }
                        }
                        if (streamInputTokens > 0 || streamOutputTokens > 0) {
                            copilotStore.incrementApiCallCount();
                            copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens);
                            copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, undefined);
                        } else {
                            copilotStore.incrementApiCallCount();
                            const estimated = estimateMessageTokens(openAIPayload.messages || []);
                            copilotStore.incrementTokenUsage(estimated, 0, 0);
                            copilotStore.recordDailyUsage(estimated, 0, 0);
                        }
                        if (!res.destroyed) {
                            res.end();
                        }
                    });

                    response.body.on('error', (error) => {
                        logger.error('Stream error (fallback):', error);
                        if (!res.destroyed) {
                            res.end();
                        }
                    });

                    res.on('close', () => {
                        if (response.body && !response.body.destroyed) {
                            response.body.destroy();
                        }
                    });
                } else {
                    const responseBody = await readBody(response.body);
                    const openAIResponse = JSON.parse(responseBody);
                    const anthropicResponse = openAIToAnthropic(openAIResponse);
                    const inputTokens = openAIResponse.usage?.prompt_tokens || 0;
                    const outputTokens = openAIResponse.usage?.completion_tokens || 0;
                    const cacheHitTokens = extractCacheHitTokens(openAIResponse.usage);
                    copilotStore.incrementApiCallCount();
                    if (inputTokens > 0 || outputTokens > 0) {
                        copilotStore.incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens);
                        copilotStore.recordDailyUsage(inputTokens, outputTokens, cacheHitTokens, undefined);
                    } else {
                        const estimated = estimateMessageTokens(anthropicPayload.messages || []);
                        copilotStore.incrementTokenUsage(estimated, 0, 0);
                        copilotStore.recordDailyUsage(estimated, 0, 0);
                    }
                    sendJson(res, 200, anthropicResponse);
                }
            }
        } catch (error) {
            logger.error('Copilot: Failed to handle Anthropic messages:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    };
}
