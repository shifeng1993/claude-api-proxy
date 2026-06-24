/**
 * Relay route surface. Protocol handling and provider/session orchestration live in relay services.
 * @module routes/relay
 */

import {unifiedTenantManager} from '../services/gateway/index.js';
import {createRelayRouteRuntime} from '../services/relay/index.js';
import logger from '../utils/logger.js';

const relayRuntime = createRelayRouteRuntime({tenantManager: unifiedTenantManager, logger});
const {
    sendJson,
    sendOpenAIError,
    sendAnthropicError,
    isTenantEnabled,
    getDiagnostics,
    handleOpenAIModels,
    handleAnthropicModels,
    handleAnthropicCountTokens,
    handleOpenAIChatCompletions,
    handleAnthropicMessages,
    handleResponsesAPI,
    handleResponsesCompact
} = relayRuntime;

export const {handleRelayResponsesWS} = relayRuntime;

export async function routeRelayRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/relay' || pathname === '/relay/') {
        sendJson(res, 200, {
            name: 'Relay API Proxy',
            version: '1.0.0',
            modes: ['openai', 'anthropic'],
            tenantEnabled: isTenantEnabled(),
            endpoints: {
                openai: {
                    chatCompletions: 'POST /relay/v1/chat/completions - OpenAI format',
                    responses: 'POST /relay/v1/responses - Responses API',
                    responsesCompact: 'POST /relay/v1/responses/compact - Responses Compact API',
                    diagnostics: 'GET /relay/v1/diagnostics - Relay session diagnostics',
                    models: 'GET /relay/v1/models - OpenAI format models'
                },
                anthropic: {
                    messages: 'POST /relay/anthropic/v1/messages - Claude format',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models - Claude format models'
                }
            }
        });
        return;
    }

    if (pathname === '/relay/v1/diagnostics' && method === 'GET') {
        if (!req.tenantId) {
            sendOpenAIError(res, 401, 'Unauthorized', 'authentication_error');
            return;
        }
        sendJson(res, 200, getDiagnostics(req.tenantId));
        return;
    }

    if (pathname.startsWith('/relay/anthropic')) {
        const anthropicPath = pathname.replace('/relay/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Relay API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /relay/anthropic/v1/messages',
                    countTokens: 'POST /relay/anthropic/v1/messages/count_tokens',
                    models: 'GET /relay/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST')
            return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    if (pathname === '/relay/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/relay/v1/responses/compact' && method === 'POST') return handleResponsesCompact(req, res);
    if (pathname === '/relay/v1/responses' && method === 'POST') return handleResponsesAPI(req, res);
    if (pathname === '/relay/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
