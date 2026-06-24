/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * @module routes/codebuddy
 */

import {createChatCompletions, getModels} from '../services/codebuddy/api.js';
import {aggregateStreamResponse} from '../services/providers/index.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic
} from '../services/codebuddy/anthropic-adapter.js';
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
} from '../services/codebuddy/protocol-adapter.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl, isPersonalHost} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/shared/index.js';
import {
    codebuddyUpstreamErrorStatus as upstreamErrorStatus,
    sendCodebuddyAnthropicError as sendAnthropicError,
    sendCodebuddyJsonResponse as sendJson,
    sendCodebuddyOpenAIError as sendOpenAIError
} from '../services/codebuddy/response-writer.js';
import {resolveCodebuddyConversationId as resolveConversationId} from '../services/codebuddy/conversation-key.js';
import {prepareCodebuddyOutboundChatRequest} from '../services/codebuddy/outbound-chat.js';
import {
    createCodebuddyCredentialResolver,
    createCodebuddyTenantCredentialManagerResolver
} from '../services/codebuddy/credential-context.js';
import {
    createCodebuddyUsageRecorder,
    pickCodebuddyUsageModel as pickModelName
} from '../services/codebuddy/usage.js';
import {mapCodebuddyModelName as mapModelName} from '../services/codebuddy/model-mapping.js';
import {createCodebuddyChatCompletionsHandler} from '../services/codebuddy/chat-completions-handler.js';
import {createCodebuddyAnthropicMessagesHandler} from '../services/codebuddy/anthropic-messages-handler.js';
import logger from '../utils/logger.js';

const authenticateAndGetCredential = createCodebuddyCredentialResolver({tenantManager: unifiedTenantManager});
const resolveTenantManager = createCodebuddyTenantCredentialManagerResolver({tenantManager: unifiedTenantManager});
const {recordUsage: recordCodebuddyUsage} = createCodebuddyUsageRecorder(unifiedTenantManager);


async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}


const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler({
    authenticateAndGetCredential,
    tenantManager: unifiedTenantManager,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
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
    tenantManager: unifiedTenantManager,
    sendAnthropicError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
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

/**
 * 处理 OpenAI 格式的 /v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const modelsData = await getModels(authResult.credential);

        // 返回 OpenAI 格式
        sendJson(res, 200, {
            object: 'list',
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'codebuddy'
            }))
        });
    } catch (error) {
        logger.error('Failed to get OpenAI models:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}


/**
 * 处理 Anthropic 格式的 /v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4);

        sendJson(res, 200, {input_tokens: estimatedTokens});
    } catch (error) {
        logger.error('Failed to count tokens:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(authResult.credential);

        sendJson(res, 200, {
            data: modelsData.data.map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: 'codebuddy',
                name: model.name,
                capabilities: {}
            })),
            object: 'list'
        });
    } catch (error) {
        logger.error('Failed to get Anthropic models:', error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 获取租户的凭证管理器（用于凭证管理端点）
 */
/**
 * 处理 OpenAI Responses API 请求 (/codebuddy/v1/responses)
 * 将 Responses 格式转为 Chat Completions 发给上游，再将响应转回 Responses 格式
 */
async function handleResponsesAPI(req, res) {
    let tenantInfo = '';
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (!authResult.error) {
            const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
            if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
        }
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        // 检测企业版凭证缺失企业信息
        if (!authResult.credential.enterprise_id) {
            const host = new URL(getCodebuddyBaseUrl(authResult.credential.base_url)).host;
            if (!isPersonalHost(host)) {
                logger.warn(
                    `[CodeBuddy Responses API]: 凭证 ${authResult.credential.user_id} 缺少 enterprise_id，上游 ${host} 可能触发配额错误`
                );
            }
        }

        const body = await parseBody(req);
        const responsesReq = JSON.parse(body);
        const conversationId = resolveConversationId(req, responsesReq.input, responsesReq, {
            tenantId: authResult.tenantId
        });

        // Responses → Chat Completions
        const chatReq = responsesRequestToChat(responsesReq);

        // 映射 Codex 传入的模型名到实际可用模型
        if (chatReq.model) {
            chatReq.model = mapModelName(chatReq.model);
        }

        prepareCodebuddyOutboundChatRequest(chatReq);

        // 从 messages 前缀推算稳定的 conversationId，确保同一对话的 prompt_cache_key 一致
        const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id'],
            ...tenantMeta
        });

        if (responsesReq.stream) {
            // 流式：解析 Chat SSE → Responses SSE
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const chatToResponsesBridge = createChatToResponsesStreamBridge({model: responsesReq.model});
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';

            response.body.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                let start = 0;
                let newLineIndex;
                while ((newLineIndex = buffer.indexOf(10, start)) !== -1) {
                    const line = buffer.toString('utf8', start, newLineIndex).trim();
                    start = newLineIndex + 1;
                    if (!line || line.startsWith(':')) continue;
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') continue;

                    let data;
                    try {
                        data = JSON.parse(raw);
                    } catch {
                        continue;
                    }

                    if (data.usage) {
                        streamInputTokens = data.usage.prompt_tokens || 0;
                        streamOutputTokens = data.usage.completion_tokens || 0;
                        streamCacheHitTokens = extractCacheHitTokens(data.usage);
                        streamCredit = data.usage.credit || 0;
                    }
                    if (data.model) streamModel = data.model;

                    const events = chatToResponsesBridge.feed(data);
                    for (const ev of events) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (start > 0) buffer = buffer.subarray(start);
            });

            response.body.on('end', () => {
                // 如果没有正常完成，兜底发送 response.completed
                if (!chatToResponsesBridge.finished) {
                    for (const ev of chatToResponsesBridge.finish()) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                    }
                }
                if (authResult.tenantId) {
                    unifiedTenantManager.incrementApiCallCount(authResult.tenantId, 'codebuddy');
                    unifiedTenantManager.incrementTokenUsage(
                        authResult.tenantId,
                        'codebuddy',
                        streamInputTokens,
                        streamOutputTokens,
                        streamCacheHitTokens
                    );
                    unifiedTenantManager.incrementCreditUsage(authResult.tenantId, 'codebuddy', streamCredit);
                    unifiedTenantManager.recordDailyUsage(
                        authResult.tenantId,
                        'codebuddy',
                        streamInputTokens,
                        streamOutputTokens,
                        streamCacheHitTokens,
                        streamCredit,
                        pickModelName(streamModel, responsesReq.model)
                    );
                }
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error(`Responses stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                res.end();
            });
        } else {
            // 非流式
            const aggregated = await aggregateStreamResponse(response.body);

            if (authResult.tenantId) {
                const inputTokens = aggregated.usage?.prompt_tokens || 0;
                const outputTokens = aggregated.usage?.completion_tokens || 0;
                const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
                const credit = aggregated.usage?.credit || 0;
                unifiedTenantManager.incrementApiCallCount(authResult.tenantId, 'codebuddy');
                unifiedTenantManager.incrementTokenUsage(
                    authResult.tenantId,
                    'codebuddy',
                    inputTokens,
                    outputTokens,
                    cacheHitTokens
                );
                unifiedTenantManager.incrementCreditUsage(authResult.tenantId, 'codebuddy', credit);
                unifiedTenantManager.recordDailyUsage(
                    authResult.tenantId,
                    'codebuddy',
                    inputTokens,
                    outputTokens,
                    cacheHitTokens,
                    credit,
                    pickModelName(aggregated.model, responsesReq.model)
                );
            }

            const chatResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || chatReq.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            reasoning_content: aggregated.reasoningContent || undefined,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop'
                    }
                ],
                usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };

            sendJson(res, 200, chatResponseToResponses(chatResponse));
        }
    } catch (error) {
        logger.error(`Failed to handle Responses API${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI Responses Compact 请求 (/codebuddy/v1/responses/compact)
 */
async function handleResponsesCompact(req, res) {
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const compactReq = JSON.parse(body);
        const conversationId = resolveConversationId(req, compactReq.input, compactReq, {
            tenantId: authResult.tenantId
        });

        // Compact → Chat Completions
        const chatReq = compactRequestToChat(compactReq);

        // 映射 Codex 传入的模型名到实际可用模型
        if (chatReq.model) {
            chatReq.model = mapModelName(chatReq.model);
        }

        prepareCodebuddyOutboundChatRequest(chatReq);

        // 从 messages 前缀推算稳定的 conversationId，确保同一对话的 prompt_cache_key 一致
        const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        const response = await createChatCompletions(chatReq, {
            credential: authResult.credential,
            conversationId,
            ...tenantMeta
        });

        const aggregated = await aggregateStreamResponse(response.body);

        if (authResult.tenantId) {
            const inputTokens = aggregated.usage?.prompt_tokens || 0;
            const outputTokens = aggregated.usage?.completion_tokens || 0;
            const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
            const credit = aggregated.usage?.credit || 0;
            unifiedTenantManager.incrementApiCallCount(authResult.tenantId, 'codebuddy');
            unifiedTenantManager.incrementTokenUsage(
                authResult.tenantId,
                'codebuddy',
                inputTokens,
                outputTokens,
                cacheHitTokens
            );
            unifiedTenantManager.incrementCreditUsage(authResult.tenantId, 'codebuddy', credit);
            unifiedTenantManager.recordDailyUsage(
                authResult.tenantId,
                'codebuddy',
                inputTokens,
                outputTokens,
                cacheHitTokens,
                credit,
                pickModelName(aggregated.model, compactReq.model)
            );
        }

        const chatResponse = {
            id: aggregated.id || `chatcmpl_${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: aggregated.model || chatReq.model,
            choices: [
                {
                    index: 0,
                    message: {role: 'assistant', content: aggregated.content || null},
                    finish_reason: aggregated.finishReason || 'stop'
                }
            ],
            usage: aggregated.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
        };

        sendJson(res, 200, chatResponseToCompact(chatResponse));
    } catch (error) {
        logger.error('Failed to handle Responses Compact:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理凭证管理端点 - 基于租户体系
 */
async function handleCredentials(req, res, method, pathname) {
    try {
        // GET /v1/credentials - 列出所有凭证
        if (method === 'GET' && pathname === '/v1/credentials') {
            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const credentials = resolved.manager.getCredentialsInfo();
            sendJson(res, 200, {credentials});
            return;
        }

        // GET /v1/credentials/current - 获取当前凭证
        if (method === 'GET' && pathname === '/v1/credentials/current') {
            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const info = resolved.manager.getCurrentCredentialInfo();
            sendJson(res, 200, info);
            return;
        }

        // POST /v1/credentials - 添加新凭证
        if (method === 'POST' && pathname === '/v1/credentials') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (!data.bearer_token) {
                sendOpenAIError(res, 400, 'bearer_token is required');
                return;
            }

            // 阻止使用已废弃域名
            const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
            if (BLOCKED_DOMAINS.includes(credentialHost)) {
                sendOpenAIError(res, 400, `域名 ${credentialHost} 已废弃，不允许添加凭证`);
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.addCredentialWithData(data, data.filename);
            if (success) {
                unifiedTenantManager.syncCredentialCount(resolved.tenantId);
                sendJson(res, 200, {message: 'Credential added successfully'});
            } else {
                sendOpenAIError(res, 500, 'Failed to save credential');
            }
            return;
        }

        // POST /v1/credentials/select - 手动选择凭证
        if (method === 'POST' && pathname === '/v1/credentials/select') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.setActiveCredential(data.index);
            if (success) {
                sendJson(res, 200, {message: `Credential #${data.index + 1} set as active`});
            } else {
                sendOpenAIError(res, 400, 'Invalid credential index');
            }
            return;
        }

        // POST /v1/credentials/delete - 删除凭证
        if (method === 'POST' && pathname === '/v1/credentials/delete') {
            const body = await parseBody(req);
            const data = JSON.parse(body);

            if (data.index === undefined || data.index === null) {
                sendOpenAIError(res, 400, 'index is required');
                return;
            }

            const resolved = await resolveTenantManager(req);
            if (resolved.error) {
                sendOpenAIError(res, resolved.error.status, resolved.error.message);
                return;
            }
            const success = await resolved.manager.deleteCredential(data.index);
            if (success) {
                unifiedTenantManager.syncCredentialCount(resolved.tenantId);
                sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
            } else {
                sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
            }
            return;
        }

        sendOpenAIError(res, 404, 'Credential endpoint not found');
    } catch (error) {
        logger.error('Credential management error:', error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    const tenantCount = unifiedTenantManager.listTenants().length;
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

/* ==================== WebSocket 端点 ==================== */

/**
 * 处理 CodeBuddy Responses API WebSocket 连接
 * 客户端通过 WS 连接 /codebuddy/v1/responses，发送标准 Responses API WS 协议
 * CodeBuddy 上游使用 OpenAI Chat HTTP，服务端做 WS→HTTP→WS 转换
 *
 * 注意：鉴权已在 server.js 的 upgrade handler 中完成，
 * 并通过 req.tenantId 注入到这里。
 *
 * @param {import('ws').WebSocket} clientWs - 客户端 WebSocket 连接
 * @param {import('http').IncomingMessage} req - 原始 HTTP 请求（已注入 tenantId）
 */
export function handleCodebuddyResponsesWS(clientWs, req) {
    req.codebuddyClientConnectionId = req.codebuddyClientConnectionId || `codebuddy-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    handleWSConnection(clientWs, {
        authenticate: () => true,
        req,
        handleRequest: async function* (payload, authResult, {signal}) {
            const tenantId = req.tenantId;
            const credential = await unifiedTenantManager
                .listCodebuddyCredentials(tenantId)
                .then(({credentials, activeIndex}) => resolveCredential(req.headers, credentials, activeIndex));
            if (!credential) {
                throw Object.assign(new Error('No available credentials for tenant'), {
                    name: 'ResponsesWebSocketError',
                    event: {
                        type: 'error',
                        error: {message: 'No available credentials for tenant', code: 'no_credentials'}
                    }
                });
            }

            // 检测企业版凭证缺失企业信息
            if (!credential.enterprise_id) {
                const host = new URL(getCodebuddyBaseUrl(credential.base_url)).host;
                if (!isPersonalHost(host)) {
                    logger.warn(
                        `[CodeBuddy WS]: 凭证 ${credential.user_id} 缺少 enterprise_id，上游 ${host} 可能触发配额错误`
                    );
                }
            }

            // Responses → Chat Completions
            const conversationId = resolveConversationId(req, payload.input, payload, {tenantId});
            const chatReq = responsesRequestToChat(payload);
            if (chatReq.model) chatReq.model = mapModelName(chatReq.model);
            prepareCodebuddyOutboundChatRequest(chatReq);
            chatReq.stream = true;

            const tenant = unifiedTenantManager.getTenant(tenantId);
            const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

            const response = await createChatCompletions(chatReq, {
                credential,
                conversationId,
                conversationRequestId: req.headers['x-conversation-request-id'],
                conversationMessageId: req.headers['x-conversation-message-id'],
                requestId: req.headers['x-request-id'],
                ...tenantMeta
            });

            // 将 Chat SSE 流转换为 Responses WS 事件
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
            unifiedTenantManager.incrementApiCallCount(tenantId, 'codebuddy');
            unifiedTenantManager.incrementTokenUsage(tenantId, 'codebuddy', inputTokens, outputTokens, cacheHitTokens);
            unifiedTenantManager.recordDailyUsage(
                tenantId,
                'codebuddy',
                inputTokens,
                outputTokens,
                cacheHitTokens,
                0,
                model
            );
        }
    });
}

/**
 * 主路由处理函数
 */
export async function routeCodebuddyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 凭证管理端点（两个模式共用）==========
    if (pathname.startsWith('/codebuddy/v1/credentials')) {
        return handleCredentials(req, res, method, pathname.replace('/codebuddy', ''));
    }

    // ========== Anthropic 模式（Claude 格式）==========
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

        // Anthropic 模式的根路径
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

    // ========== OpenAI 模式（默认）==========
    // 注意：所有非 anthropic 路径都走 OpenAI 模式

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

    // OpenAI 模式的根路径
    if (
        pathname === '/codebuddy' ||
        pathname === '/codebuddy/' ||
        pathname === '/codebuddy/v1' ||
        pathname === '/codebuddy/v1/'
    ) {
        return handleRoot(req, res);
    }

    // 未匹配到任何路由
    sendOpenAIError(res, 404, 'Endpoint not found');
}
