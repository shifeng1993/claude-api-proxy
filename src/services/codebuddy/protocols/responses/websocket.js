function createResponsesWebSocketError(message, code = 'no_credentials') {
    return Object.assign(new Error(message), {
        name: 'ResponsesWebSocketError',
        event: {
            type: 'error',
            error: {message, code}
        }
    });
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
            `[CodeBuddy WS]: credential ${credential.user_id} missing enterprise_id; upstream ${host} may reject quota`
        );
    }
}

function defaultConnectionId() {
    return `codebuddy-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createCodebuddyResponsesWebSocketHandler({
    handleWSConnection,
    resolveCredentialContext,
    tenantManager,
    getCodebuddyBaseUrl,
    isPersonalHost,
    resolveConversationId,
    responsesRequestToChat,
    mapModelName,
    prepareCodebuddyOutboundChatRequest,
    createChatCompletions,
    createChatToResponsesStreamBridge,
    recordUsage,
    logger = console,
    makeConnectionId = defaultConnectionId
}) {
    return function handleCodebuddyResponsesWS(clientWs, req) {
        req.codebuddyClientConnectionId = req.codebuddyClientConnectionId || makeConnectionId();
        handleWSConnection(clientWs, {
            authenticate: () => true,
            req,
            handleRequest: async function* handleCodebuddyResponsesWSRequest(payload, authResult, {signal}) {
                const credentialResult = await resolveCredentialContext(req);
                if (credentialResult.error || !credentialResult.credential) {
                    throw createResponsesWebSocketError(
                        credentialResult.error?.message || 'No available credentials for tenant'
                    );
                }

                const tenantId = credentialResult.tenantId || req.tenantId;
                const {credential} = credentialResult;
                warnIfEnterpriseContextMissing({
                    credential,
                    getCodebuddyBaseUrl,
                    isPersonalHost,
                    logger
                });

                const conversationId = resolveConversationId(req, payload.input, payload, {tenantId});
                const chatReq = responsesRequestToChat(payload);
                if (chatReq.model) chatReq.model = mapModelName(chatReq.model);
                prepareCodebuddyOutboundChatRequest(chatReq);
                chatReq.stream = true;

                const tenant = await tenantManager.getTenant(tenantId);
                const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};
                const response = await createChatCompletions(chatReq, {
                    credential,
                    conversationId,
                    conversationRequestId: req.headers['x-conversation-request-id'],
                    conversationMessageId: req.headers['x-conversation-message-id'],
                    requestId: req.headers['x-request-id'],
                    ...tenantMeta
                });

                const chatToResponsesBridge = createChatToResponsesStreamBridge({model: payload.model});
                let buffer = Buffer.alloc(0);

                for await (const chunk of response.body) {
                    if (signal?.aborted) break;
                    buffer = Buffer.concat([buffer, chunk]);
                    let start = 0;
                    let newLineIndex;
                    while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                        const line = buffer.toString('utf8', start, newLineIndex).trim();
                        start = newLineIndex + 1;
                        if (!line || line.startsWith(':') || !line.startsWith('data: ')) continue;
                        const raw = line.slice(6).trim();
                        if (raw === '[DONE]') continue;

                        let data;
                        try {
                            data = JSON.parse(raw);
                        } catch {
                            continue;
                        }

                        const events = chatToResponsesBridge.feed(data);
                        for (const ev of events) {
                            yield {type: ev.event, data: ev.data};
                        }
                    }
                    if (start > 0) buffer = buffer.subarray(start);
                }
                if (!chatToResponsesBridge.finished) {
                    for (const ev of chatToResponsesBridge.finish()) {
                        yield {type: ev.event, data: ev.data};
                    }
                }
            },
            onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
                const tenantId = req.tenantId;
                if (!tenantId) return;
                recordUsage(
                    tenantId,
                    inputTokens,
                    outputTokens,
                    cacheHitTokens,
                    0,
                    model,
                    model
                );
            }
        });
    };
}
