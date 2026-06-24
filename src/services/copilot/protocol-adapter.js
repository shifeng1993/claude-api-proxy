/**
 * Copilot protocol adapter facade.
 * Keeps route handlers decoupled from the protocol core file layout.
 * @module services/copilot/protocol-adapter
 */

export {
    chatRequestToResponses,
    chatResponseToCompact,
    chatResponseToResponses,
    compactRequestToChat,
    convertResponsesUsageToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToAnthropicStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    extractCacheHitTokens,
    responsesRequestToChat,
    responsesResponseToChat,
    sanitizeAnthropicPayload,
    sanitizeResponsesInput
} from '../../core/protocol/index.js';
