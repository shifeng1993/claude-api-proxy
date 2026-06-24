export function createCopilotMetadataHandlers({
    getCopilotNetworkOptions,
    ensureCopilotAuth,
    getModels,
    copilotState,
    sendOpenAIError,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    sanitizeAnthropicPayload,
    estimateMessageTokens,
    estimateContentBlockTokens,
    logger = console
}) {
    async function handleOpenAIModels(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendOpenAIError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const modelsData = await getModels(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            sendJson(res, 200, {
                object: 'list',
                data: (modelsData.data || []).map((model) => ({
                    id: model.id,
                    object: 'model',
                    created: 0,
                    owned_by: model.vendor || 'copilot'
                }))
            });
        } catch (error) {
            logger.error('Copilot: Failed to get OpenAI models:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicCountTokens(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const body = await parseBody(req);
            const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));
            let totalTokens = 0;

            if (Array.isArray(anthropicPayload.messages)) {
                totalTokens += estimateMessageTokens(anthropicPayload.messages);
            }

            if (anthropicPayload.system) {
                if (typeof anthropicPayload.system === 'string') {
                    totalTokens += Math.ceil(anthropicPayload.system.length / 4);
                } else if (Array.isArray(anthropicPayload.system)) {
                    for (const block of anthropicPayload.system) {
                        totalTokens += estimateContentBlockTokens(block);
                    }
                }
            }

            if (Array.isArray(anthropicPayload.tools)) {
                for (const tool of anthropicPayload.tools) {
                    totalTokens += Math.ceil((tool.name || '').length / 4);
                    totalTokens += Math.ceil((tool.description || '').length / 4);
                    if (tool.input_schema) {
                        const schemaStr = JSON.stringify(tool.input_schema);
                        totalTokens += Math.ceil(schemaStr.length / 2);
                    }
                }
            }

            sendJson(res, 200, {input_tokens: totalTokens});
        } catch (error) {
            logger.error('Copilot: Failed to count tokens:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    async function handleAnthropicModels(req, res) {
        try {
            const networkOptions = getCopilotNetworkOptions(req);
            const proxyUrl = networkOptions.proxyUrl;
            const authResult = await ensureCopilotAuth(networkOptions);
            if (authResult.error) {
                sendAnthropicError(res, authResult.error.status, authResult.error.message);
                return;
            }

            const modelsData = await getModels(
                authResult.copilotToken,
                copilotState.vsCodeVersion,
                copilotState.accountType,
                proxyUrl,
                networkOptions
            );

            sendJson(res, 200, {
                object: 'list',
                data: (modelsData.data || []).map((model) => ({
                    id: model.id,
                    object: 'model',
                    created: 0,
                    owned_by: model.vendor || 'copilot',
                    name: model.name,
                    capabilities: model.capabilities || {}
                }))
            });
        } catch (error) {
            logger.error('Copilot: Failed to get Anthropic models:', error);
            sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    return {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    };
}
