import {
    compactChatRequestIfNeeded as defaultCompactChatRequestIfNeeded,
    isContextWindowExceededError as defaultIsContextWindowExceededError
} from '../session/index.js';

export async function generateRelayContextSummary({
    summaryRequest,
    upstream,
    upstreamManager,
    tenantId,
    tenantMeta = {},
    conversationKey,
    originalModel,
    requestType,
    req,
    isAnthropicUpstream,
    chatRequestToAnthropic,
    createAnthropicMessages,
    createChatCompletions,
    callUpstream,
    getAnthropicRequestHeaders,
    readResponseBody,
    anthropicResponseToChat,
    recordUsage,
    extractCacheHitTokens
}) {
    const model = upstreamManager.resolveModel(summaryRequest.model || originalModel, upstream.index);
    const payload = {...summaryRequest, model, stream: false};
    const compactConversationKey = conversationKey ? `${conversationKey}:compact` : undefined;
    const compactMeta = {
        requestType: `${requestType}ContextCompaction`,
        stream: false,
        originalModel,
        conversationKey: compactConversationKey,
        sessionId: compactConversationKey,
        ...tenantMeta
    };

    if (isAnthropicUpstream(upstream)) {
        const anthropicPayload = chatRequestToAnthropic(payload);
        const {response} = await callUpstream(upstream, (up) =>
            createAnthropicMessages(
                anthropicPayload,
                up,
                compactMeta,
                getAnthropicRequestHeaders(req)
            )
        );
        const responseBody = await readResponseBody(response.body);
        const parsed = JSON.parse(responseBody);
        const chatResponse = anthropicResponseToChat(parsed, originalModel || model);
        recordUsage(
            tenantId,
            chatResponse.usage?.prompt_tokens || 0,
            chatResponse.usage?.completion_tokens || 0,
            extractCacheHitTokens(chatResponse.usage),
            model
        );
        return chatResponse.choices?.[0]?.message?.content || '';
    }

    const {response} = await callUpstream(upstream, (up) =>
        createChatCompletions(payload, up, compactMeta)
    );
    const responseBody = await readResponseBody(response.body);
    const parsed = JSON.parse(responseBody);
    recordUsage(
        tenantId,
        parsed.usage?.prompt_tokens || 0,
        parsed.usage?.completion_tokens || 0,
        extractCacheHitTokens(parsed.usage),
        model
    );
    return parsed.choices?.[0]?.message?.content || '';
}

export async function compactRelayChatRequest({
    chatRequest,
    upstream,
    upstreamManager,
    tenantId,
    tenantMeta,
    conversationKey,
    originalModel,
    requestType,
    req,
    force = false,
    reason,
    compactChatRequestIfNeeded = defaultCompactChatRequestIfNeeded,
    conversationStore,
    logger,
    generateSummary = generateRelayContextSummary,
    ...summaryDependencies
}) {
    const result = await compactChatRequestIfNeeded({
        chatRequest,
        force,
        reason,
        summarize: ({summaryRequest}) => generateSummary({
            summaryRequest,
            upstream,
            upstreamManager,
            tenantId,
            tenantMeta,
            conversationKey,
            originalModel,
            requestType,
            req,
            ...summaryDependencies
        })
    });

    if (result.compacted) {
        conversationStore.saveChatRequest({
            tenantId,
            conversationKey,
            request: result.chatRequest
        });
        logger.info(
            `Relay context compacted (${requestType}): messages ${result.oldMessageCount}+${result.recentMessageCount}, tokens ${result.estimatedTokens}->${result.compactedTokens}`
        );
    }

    return result;
}

export async function invokeWithRelayContextCompaction({
    chatRequest,
    compactOptions,
    invoke,
    compactRelayChatRequest,
    isContextWindowExceededError = defaultIsContextWindowExceededError,
    logger
}) {
    let prepared = {chatRequest};
    try {
        prepared = await compactRelayChatRequest({
            ...compactOptions,
            chatRequest,
            force: false
        });
    } catch (error) {
        logger.warn(`Relay context proactive compaction skipped: ${error.message}`);
        prepared = {chatRequest};
    }

    try {
        return {
            chatRequest: prepared.chatRequest,
            result: await invoke(prepared.chatRequest),
            retriedAfterCompaction: false
        };
    } catch (error) {
        if (!isContextWindowExceededError(error)) throw error;

        logger.warn(`Relay context exceeded, compacting and retrying once: ${error.message}`);
        let retryPrepared;
        try {
            retryPrepared = await compactRelayChatRequest({
                ...compactOptions,
                chatRequest: prepared.chatRequest,
                force: true,
                reason: 'context-window-exceeded'
            });
        } catch (compactionError) {
            logger.warn(`Relay context reactive compaction failed: ${compactionError.message}`);
            throw error;
        }
        if (!retryPrepared.compacted) throw error;

        return {
            chatRequest: retryPrepared.chatRequest,
            result: await invoke(retryPrepared.chatRequest),
            retriedAfterCompaction: true
        };
    }
}

export function createRelayContextCompaction({
    compactChatRequestIfNeeded = defaultCompactChatRequestIfNeeded,
    isContextWindowExceededError = defaultIsContextWindowExceededError,
    ...dependencies
}) {
    const compactWithDependencies = (options) =>
        compactRelayChatRequest({
            compactChatRequestIfNeeded,
            ...dependencies,
            ...options
        });

    return {
        generateRelayContextSummary: (options) =>
            generateRelayContextSummary({
                ...dependencies,
                ...options
            }),
        compactRelayChatRequest: compactWithDependencies,
        invokeWithRelayContextCompaction: ({chatRequest, compactOptions, invoke}) =>
            invokeWithRelayContextCompaction({
                chatRequest,
                compactOptions,
                invoke,
                compactRelayChatRequest: compactWithDependencies,
                isContextWindowExceededError,
                logger: dependencies.logger
            })
    };
}
