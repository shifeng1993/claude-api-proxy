/**
 * CodeBuddy protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/codebuddy/protocol-adapter
 */

export {
    anthropicRequestToChat,
    buildConversationAnchorKey,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    mergeConsecutiveAssistantMessages,
    normalizePayload,
    openAIToAnthropic,
    prepareOpenAIChatUpstreamRequest,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    stripDynamicReminders
} from '#protocol-engine';
