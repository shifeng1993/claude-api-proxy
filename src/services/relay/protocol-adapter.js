/**
 * Relay protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/relay/protocol-adapter
 */

export {
    anthropicRequestToResponses,
    anthropicRequestToChat,
    anthropicResponseToChat,
    buildConversationAnchorKey,
    canonicalFromAnthropicRequest,
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicStreamChatResponse,
    chatRequestToAnthropic,
    chatRequestToRelayResponses,
    chatResponseToAnthropic,
    chatResponseToCompact,
    chatResponseToRelayResponses,
    compactRequestToChat,
    createAnthropicStreamAccumulator,
    createAnthropicToResponsesStreamBridge,
    createChatStreamAccumulator,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesStreamAccumulator,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    extractCacheHitTokens,
    extractInputTokens,
    getRelayConversationDiagnostics,
    limitResponsesInputItems,
    mapStopReason,
    mergeConsecutiveAssistantMessages,
    openAIToAnthropic,
    responsesResponseToRelayChat,
    renderCanonicalToAnthropic,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    streamAnthropicSSEToChatChunks,
    stripDynamicReminders
} from '#protocol-engine';
