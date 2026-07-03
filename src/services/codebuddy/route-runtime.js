import {createChatCompletions, getModels} from './api.js';
import {aggregateStreamResponse} from '../providers/index.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic
} from './anthropic-adapter.js';
import {
    chatResponseToResponses,
    chatResponseToCompact,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload
} from './protocol-adapter.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl, isPersonalHost} from './config.js';
import {handleWSConnection} from '../shared/index.js';
import {
    codebuddyUpstreamErrorStatus as upstreamErrorStatus,
    sendCodebuddyAnthropicError as sendAnthropicError,
    sendCodebuddyJsonResponse as sendJson,
    sendCodebuddyOpenAIError as sendOpenAIError
} from './response-writer.js';
import {resolveCodebuddyConversationId as resolveConversationId} from './conversation-key.js';
import {
    createCodebuddyCredentialResolver,
    createCodebuddyTenantCredentialManagerResolver
} from './credential-context.js';
import {getCodebuddyCredentialService} from './credential-service.js';
import {createCodebuddyUsageRecorder} from './usage.js';
import {mapCodebuddyModelName as mapModelName} from './model-mapping.js';
import {
    createCodebuddyChatCompletionsHandler,
    prepareCodebuddyOutboundChatRequest
} from './protocols/chat/index.js';
import {createCodebuddyAnthropicMessagesHandler} from './protocols/anthropic/index.js';
import {
    createCodebuddyResponsesAPIHandler,
    createCodebuddyResponsesCompactHandler,
    createCodebuddyResponsesWebSocketHandler
} from './protocols/responses/index.js';
import {createCodebuddyMetadataHandlers} from './metadata-handler.js';
import {createCodebuddyCredentialsHandler} from './credentials-handler.js';
import defaultLogger from '../../utils/logger.js';

export async function readCodebuddyRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function createCodebuddyRouteRuntime({tenantManager, resolveCredential, logger = defaultLogger} = {}) {
    if (!tenantManager) {
        throw new Error('createCodebuddyRouteRuntime requires a tenantManager');
    }
    if (typeof resolveCredential !== 'function') {
        throw new Error('createCodebuddyRouteRuntime requires resolveCredential');
    }

    const credentialService = getCodebuddyCredentialService(tenantManager);
    const authenticateAndGetCredential = createCodebuddyCredentialResolver({
        credentialService,
        resolveCredential
    });
    const resolveTenantManager = createCodebuddyTenantCredentialManagerResolver({credentialService});
    const {recordUsage: recordCodebuddyUsage} = createCodebuddyUsageRecorder(tenantManager);

    const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        mapModelName,
        resolveConversationId,
        prepareCodebuddyOutboundChatRequest,
        createChatCompletions,
        rewriteOpenAIStream,
        aggregateStreamResponse,
        extractCacheHitTokens,
        recordUsage: recordCodebuddyUsage,
        logger
    });

    const handleAnthropicMessages = createCodebuddyAnthropicMessagesHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        sanitizeAnthropicPayload,
        anthropicToOpenAI,
        mapModelName,
        resolveConversationId,
        prepareCodebuddyOutboundChatRequest,
        createChatCompletions,
        createChatToAnthropicStreamBridge,
        aggregateStreamResponse,
        extractCacheHitTokens,
        openAIToAnthropic,
        recordUsage: recordCodebuddyUsage,
        logger
    });

    const handleResponsesCompact = createCodebuddyResponsesCompactHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        resolveConversationId,
        compactRequestToChat,
        mapModelName,
        prepareCodebuddyOutboundChatRequest,
        createChatCompletions,
        aggregateStreamResponse,
        extractCacheHitTokens,
        recordUsage: recordCodebuddyUsage,
        chatResponseToCompact,
        logger
    });

    const handleResponsesAPI = createCodebuddyResponsesAPIHandler({
        authenticateAndGetCredential,
        tenantManager,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        getCodebuddyBaseUrl,
        isPersonalHost,
        resolveConversationId,
        responsesRequestToChat,
        mapModelName,
        prepareCodebuddyOutboundChatRequest,
        createChatCompletions,
        createChatToResponsesStreamBridge,
        aggregateStreamResponse,
        extractCacheHitTokens,
        recordUsage: recordCodebuddyUsage,
        chatResponseToResponses,
        logger
    });

    const handleCodebuddyResponsesWS = createCodebuddyResponsesWebSocketHandler({
        handleWSConnection,
        resolveCredentialContext: authenticateAndGetCredential,
        tenantManager,
        getCodebuddyBaseUrl,
        isPersonalHost,
        resolveConversationId,
        responsesRequestToChat,
        mapModelName,
        prepareCodebuddyOutboundChatRequest,
        createChatCompletions,
        createChatToResponsesStreamBridge,
        recordUsage: recordCodebuddyUsage,
        logger
    });

    const {
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels
    } = createCodebuddyMetadataHandlers({
        authenticateAndGetCredential,
        getModels,
        sendOpenAIError,
        sendAnthropicError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        sanitizeAnthropicPayload,
        logger
    });

    const handleCredentials = createCodebuddyCredentialsHandler({
        resolveTenantManager,
        credentialService,
        sendOpenAIError,
        sendJson,
        upstreamErrorStatus,
        parseBody: readCodebuddyRequestBody,
        getCodebuddyBaseUrl,
        blockedDomains: BLOCKED_DOMAINS,
        logger
    });

    function handleRoot(req, res) {
        const tenantCount = tenantManager.listTenants().length;
        sendJson(res, 200, {
            name: 'CodeBuddy API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            tenantCount,
            endpoints: {
                openai: {
                    chatCompletions: 'POST /codebuddy/v1/chat/completions - OpenAI format',
                    responses: 'POST /codebuddy/v1/responses - Responses API',
                    responsesCompact: 'POST /codebuddy/v1/responses/compact - Responses Compact API',
                    models: 'GET /codebuddy/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /codebuddy/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                    models: 'GET /codebuddy/anthropic/v1/models - Claude format models'
                },
                credentials: 'GET/POST /codebuddy/v1/credentials - Manage credentials'
            }
        });
    }

    async function routeCodebuddyRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;
        const method = req.method;

        if (pathname.startsWith('/codebuddy/v1/credentials')) {
            return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
        }

        if (pathname.startsWith('/codebuddy/anthropic')) {
            const anthropicPath = pathname.replace('/codebuddy/anthropic', '');

            if (anthropicPath === '/v1/messages' && method === 'POST') {
                return handleAnthropicMessages(req, res);
            }

            if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') {
                return handleAnthropicCountTokens(req, res);
            }

            if (anthropicPath === '/v1/models' && method === 'GET') {
                return handleAnthropicModels(req, res);
            }

            if (anthropicPath === '' || anthropicPath === '/') {
                sendJson(res, 200, {
                    name: 'CodeBuddy API Proxy - Anthropic Mode',
                    version: '1.0.0',
                    endpoints: {
                        messages: 'POST /codebuddy/anthropic/v1/messages',
                        countTokens: 'POST /codebuddy/anthropic/v1/messages/count_tokens',
                        models: 'GET /codebuddy/anthropic/v1/models'
                    }
                });
                return;
            }

            sendAnthropicError(res, 404, 'Endpoint not found');
            return;
        }

        if (pathname === '/codebuddy/v1/chat/completions' && method === 'POST') {
            return handleOpenAIChatCompletions(req, res);
        }

        if (pathname === '/codebuddy/v1/responses/compact' && method === 'POST') {
            return handleResponsesCompact(req, res);
        }

        if (pathname === '/codebuddy/v1/responses' && method === 'POST') {
            return handleResponsesAPI(req, res);
        }

        if (pathname === '/codebuddy/v1/models' && method === 'GET') {
            return handleOpenAIModels(req, res);
        }

        if (
            pathname === '/codebuddy' ||
            pathname === '/codebuddy/' ||
            pathname === '/codebuddy/v1' ||
            pathname === '/codebuddy/v1/'
        ) {
            return handleRoot(req, res);
        }

        sendOpenAIError(res, 404, 'Endpoint not found');
    }

    return {
        sendJson,
        sendOpenAIError,
        sendAnthropicError,
        handleCredentials,
        handleRoot,
        handleOpenAIModels,
        handleAnthropicCountTokens,
        handleAnthropicModels,
        handleOpenAIChatCompletions,
        handleAnthropicMessages,
        handleResponsesCompact,
        handleResponsesAPI,
        handleCodebuddyResponsesWS,
        routeCodebuddyRequest
    };
}
