import {
    createChatCompletions,
    createResponses,
    createResponsesWebSocket,
    releaseResponsesWebSocketConnection,
    discardResponsesWebSocketConnection,
    createAnthropicMessages,
    createAnthropicCountTokens,
    getUpstreamModels,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    aggregateStreamResponse
} from '../providers/index.js';
import {
    anthropicToOpenAI,
    injectBehaviorRules
} from './anthropic-adapter.js';
import {extractConversationKey} from './conversation-key.js';
import {createRelayUsageRecorder} from './usage.js';
import {
    callRelayUpstream as callUpstream,
    createRelayUpstreamContextResolver,
    getRelayProtocolErrorMessage as getProtocolErrorMessage,
    relayUpstreamErrorStatus as upstreamErrorStatus
} from './upstream-context.js';
import {
    createRelayCompletedResponseRecorder,
    createRelayResponsesPassthroughLimiter,
    createRelayResponsesWebSocketCollector
} from './response-state.js';
import {
    sendRelayAnthropicError as sendAnthropicError,
    sendRelayJsonResponse as sendJson,
    sendRelayOpenAIError as sendOpenAIError,
    sendRelayResponsesWebSocketProtocolError as sendResponsesWebSocketProtocolError,
    sendRelayStateMissingOpenAIError as sendStateMissingOpenAIError,
    toRelayResponsesWebSocketStateMissingError as toResponsesWebSocketStateMissingError
} from './response-writer.js';
import {
    getRelaySSEEventType as getSSEEventType,
    parseRelayResponsesSSEEvents as parseResponsesSSEEvents,
    parseRelaySSEBlock as parseSSEBlock,
    readRelayRequestBody as parseBody,
    readRelayResponseBody as readResponseBody
} from './stream-events.js';
import {
    getAnthropicRequestHeaders,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic
} from './model-metadata.js';
import {createRelayMetadataHandlers} from './metadata-endpoints.js';
import {createRelayChatCompletionsHandler} from './chat-completions-handler.js';
import {createRelayAnthropicMessagesHandler} from './anthropic-messages-handler.js';
import {createRelayResponsesAPIHandler} from './responses-api-handler.js';
import {createRelayResponsesCompactHandler} from './responses-compact-handler.js';
import {createRelayResponsesWebSocketHandler} from './responses-websocket-handler.js';
import {prepareRelayOutboundChatRequest} from './outbound-chat.js';
import {createRelayContextCompaction} from './context-compaction.js';
import {
    estimateRelayAnthropicInputTokens as estimateAnthropicInputTokens,
    handleRelayAnthropicUsageEvent as handleAnthropicUsageEvent
} from './anthropic-usage.js';
import {
    streamRelayResponsesEventsAsAnthropic as streamResponsesEventsAsAnthropic,
    writeRelayAnthropicEvent as writeAnthropicEvent
} from './anthropic-stream.js';
import {createRelayOpenAIStreamPassthrough} from './openai-stream.js';
import {
    anthropicResponseToChat,
    stripDynamicReminders,
    sanitizeAnthropicPayload,
    extractCacheHitTokens,
    extractInputTokens,
    compactRequestToChat,
    chatResponseToCompact,
    mergeConsecutiveAssistantMessages,
    createAnthropicStreamAccumulator,
    createChatStreamAccumulator,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToChatStreamBridge,
    createResponsesToResponsesStreamBridge,
    streamAnthropicSSEToChatChunks,
    createResponsesStreamAccumulator,
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicStreamChatResponse,
    getRelayConversationDiagnostics,
    chatResponseToAnthropic,
    chatResponseToRelayResponses,
    chatRequestToRelayResponses,
    chatRequestToAnthropic,
    responsesResponseToRelayChat
} from './protocol-adapter.js';
import {
    handleWSConnection,
    isResponsesWebSocketProtocolError
} from '../shared/index.js';
import {
    RelayStateMissingError,
    relayConversationStore,
    prepareResponsesContinuationPayload
} from '../session/index.js';
import defaultLogger from '../../utils/logger.js';

export function createRelayRouteRuntime({tenantManager, logger = defaultLogger} = {}) {
    if (!tenantManager) {
        throw new Error('createRelayRouteRuntime requires a tenantManager');
    }

    const {
        recordResponsesUsage,
        recordUsage
    } = createRelayUsageRecorder(tenantManager);
    const authenticateAndGetUpstream = createRelayUpstreamContextResolver(tenantManager);
    const recordCompletedResponseState = createRelayCompletedResponseRecorder(relayConversationStore);
    const limitResponsesPassthroughPayload = createRelayResponsesPassthroughLimiter({logger});
    const collectResponsesWebSocketResponse = createRelayResponsesWebSocketCollector({
        releaseConnection: releaseResponsesWebSocketConnection,
        discardConnection: discardResponsesWebSocketConnection
    });
    const {invokeWithRelayContextCompaction} = createRelayContextCompaction({
        conversationStore: relayConversationStore,
        logger,
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
    });
    const streamOpenAIPassthrough = createRelayOpenAIStreamPassthrough({
        conversationStore: relayConversationStore,
        recordUsage,
        logger
    });
    const {
        handleOpenAIModels,
        handleAnthropicModels,
        handleAnthropicCountTokens
    } = createRelayMetadataHandlers({
        authenticateAndGetUpstream,
        getUpstreamModels,
        getAnthropicRequestHeaders,
        isAnthropicUpstream,
        isResponsesUpstream,
        isResponsesWebSocketUpstream,
        createAnthropicCountTokens,
        callUpstream,
        readResponseBody,
        parseBody,
        sanitizeAnthropicPayload,
        mapAnthropicModelsToOpenAI,
        mapOpenAIModelsToAnthropic,
        getProtocolErrorMessage,
        upstreamErrorStatus,
        sendJson,
        sendOpenAIError,
        sendAnthropicError,
        logger
    });
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler({
        authenticateAndGetUpstream,
        tenantDirectory: tenantManager,
        sendOpenAIError,
        sendJson,
        sendStateMissingOpenAIError,
        sendResponsesWebSocketProtocolError,
        upstreamErrorStatus,
        parseBody,
        injectBehaviorRules,
        stripDynamicReminders,
        mergeConsecutiveAssistantMessages,
        extractConversationKey,
        relayConversationStore,
        isAnthropicUpstream,
        isResponsesWebSocketUpstream,
        isResponsesUpstream,
        callUpstream,
        createAnthropicMessages,
        getAnthropicRequestHeaders,
        createChatStreamAccumulator,
        streamAnthropicSSEToChatChunks,
        parseSSEBlock,
        canonicalFromAnthropicStreamChatResponse,
        recordUsage,
        extractCacheHitTokens,
        readResponseBody,
        anthropicResponseToChat,
        chatRequestToAnthropic,
        chatRequestToRelayResponses,
        prepareResponsesContinuationPayload,
        createResponsesWebSocket,
        releaseResponsesWebSocketConnection,
        discardResponsesWebSocketConnection,
        createResponsesToChatStreamBridge,
        createResponsesStreamAccumulator,
        collectResponsesWebSocketResponse,
        recordCompletedResponseState,
        recordResponsesUsage,
        responsesResponseToRelayChat,
        createResponses,
        getSSEEventType,
        extractInputTokens,
        createChatCompletions,
        streamOpenAIPassthrough,
        RelayStateMissingError,
        isResponsesWebSocketProtocolError,
        logger
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler({
        authenticateAndGetUpstream,
        tenantDirectory: tenantManager,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody,
        sanitizeAnthropicPayload,
        anthropicToOpenAI,
        injectBehaviorRules,
        stripDynamicReminders,
        mergeConsecutiveAssistantMessages,
        extractConversationKey,
        relayConversationStore,
        isAnthropicUpstream,
        isResponsesWebSocketUpstream,
        isResponsesUpstream,
        callUpstream,
        createAnthropicMessages,
        getAnthropicRequestHeaders,
        createAnthropicStreamAccumulator,
        parseSSEBlock,
        handleAnthropicUsageEvent,
        anthropicResponseToChat,
        recordUsage,
        estimateAnthropicInputTokens,
        readResponseBody,
        extractInputTokens,
        extractCacheHitTokens,
        chatRequestToRelayResponses,
        prepareResponsesContinuationPayload,
        createResponsesWebSocket,
        releaseResponsesWebSocketConnection,
        discardResponsesWebSocketConnection,
        createResponsesStreamAccumulator,
        streamResponsesEventsAsAnthropic,
        recordCompletedResponseState,
        recordResponsesUsage,
        collectResponsesWebSocketResponse,
        responsesResponseToRelayChat,
        chatResponseToAnthropic,
        createResponses,
        parseResponsesSSEEvents,
        createChatCompletions,
        createChatToAnthropicStreamBridge,
        createChatStreamAccumulator,
        writeAnthropicEvent,
        aggregateStreamResponse,
        logger
    });
    const handleResponsesAPI = createRelayResponsesAPIHandler({
        authenticateAndGetUpstream,
        sendOpenAIError,
        sendJson,
        sendStateMissingOpenAIError,
        sendResponsesWebSocketProtocolError,
        upstreamErrorStatus,
        parseBody,
        isAnthropicUpstream,
        isResponsesWebSocketUpstream,
        isResponsesUpstream,
        extractConversationKey,
        relayConversationStore,
        tenantDirectory: tenantManager,
        invokeWithRelayContextCompaction,
        prepareRelayOutboundChatRequest,
        chatRequestToAnthropic,
        callUpstream,
        createAnthropicMessages,
        getAnthropicRequestHeaders,
        createChatToResponsesStreamBridge,
        createResponsesStreamAccumulator,
        createChatStreamAccumulator,
        streamAnthropicSSEToChatChunks,
        parseSSEBlock,
        canonicalFromAnthropicStreamChatResponse,
        recordCompletedResponseState,
        recordUsage,
        extractCacheHitTokens,
        readResponseBody,
        anthropicResponseToChat,
        chatResponseToRelayResponses,
        canonicalFromAnthropicResponse,
        createResponsesWebSocket,
        limitResponsesPassthroughPayload,
        createResponsesToResponsesStreamBridge,
        releaseResponsesWebSocketConnection,
        discardResponsesWebSocketConnection,
        recordResponsesUsage,
        collectResponsesWebSocketResponse,
        createResponses,
        getSSEEventType,
        extractInputTokens,
        createChatCompletions,
        aggregateStreamResponse,
        RelayStateMissingError,
        isResponsesWebSocketProtocolError,
        logger
    });

    const handleResponsesCompact = createRelayResponsesCompactHandler({
        authenticateAndGetUpstream,
        sendOpenAIError,
        sendJson,
        sendResponsesWebSocketProtocolError,
        upstreamErrorStatus,
        parseBody,
        isAnthropicUpstream,
        isResponsesWebSocketUpstream,
        isResponsesUpstream,
        extractConversationKey,
        tenantDirectory: tenantManager,
        compactRequestToChat,
        injectBehaviorRules,
        stripDynamicReminders,
        mergeConsecutiveAssistantMessages,
        chatRequestToAnthropic,
        callUpstream,
        createAnthropicMessages,
        getAnthropicRequestHeaders,
        readResponseBody,
        anthropicResponseToChat,
        extractCacheHitTokens,
        recordUsage,
        chatResponseToCompact,
        chatRequestToRelayResponses,
        limitResponsesPassthroughPayload,
        createResponsesWebSocket,
        collectResponsesWebSocketResponse,
        recordResponsesUsage,
        responsesResponseToRelayChat,
        createResponses,
        extractInputTokens,
        createChatCompletions,
        aggregateStreamResponse,
        isResponsesWebSocketProtocolError,
        logger
    });

    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler({
        authenticateAndGetUpstream,
        tenantDirectory: tenantManager,
        handleWSConnection,
        recordUsage,
        extractConversationKey,
        isAnthropicUpstream,
        isResponsesWebSocketUpstream,
        isResponsesUpstream,
        relayConversationStore,
        RelayStateMissingError,
        toResponsesWebSocketStateMissingError,
        invokeWithRelayContextCompaction,
        prepareRelayOutboundChatRequest,
        chatRequestToAnthropic,
        callUpstream,
        createAnthropicMessages,
        getAnthropicRequestHeaders,
        createChatToResponsesStreamBridge,
        createChatStreamAccumulator,
        createResponsesStreamAccumulator,
        streamAnthropicSSEToChatChunks,
        parseSSEBlock,
        canonicalFromAnthropicStreamChatResponse,
        recordCompletedResponseState,
        limitResponsesPassthroughPayload,
        createResponsesWebSocket,
        discardResponsesWebSocketConnection,
        releaseResponsesWebSocketConnection,
        createResponses,
        getSSEEventType,
        createChatCompletions
    });

    return {
        sendJson,
        sendOpenAIError,
        sendAnthropicError,
        isTenantEnabled: () => tenantManager.isEnabled(),
        getDiagnostics: (tenantId) => getRelayConversationDiagnostics(relayConversationStore, {tenantId}),
        handleOpenAIModels,
        handleAnthropicModels,
        handleAnthropicCountTokens,
        handleOpenAIChatCompletions,
        handleAnthropicMessages,
        handleResponsesAPI,
        handleResponsesCompact,
        handleRelayResponsesWS
    };
}
