/**
 * CodeBuddy protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/codebuddy/protocol-adapter
 */

export {
    buildConversationAnchorKey,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    mergeConsecutiveAssistantMessages,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    stripDynamicReminders
} from '../../core/protocol/index.js';
