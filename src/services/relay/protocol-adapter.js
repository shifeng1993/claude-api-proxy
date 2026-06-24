/**
 * Relay protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/relay/protocol-adapter
 */

export {
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
    mergeConsecutiveAssistantMessages,
    responsesResponseToRelayChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    streamAnthropicSSEToChatChunks,
    stripDynamicReminders
} from '../../core/protocol/index.js';
