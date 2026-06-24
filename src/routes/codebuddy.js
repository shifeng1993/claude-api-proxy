/**
 * CodeBuddy 路由处理器 - 支持 OpenAI 直出和 Claude 兼容模式
 * @module routes/codebuddy
 */

import {createChatCompletions, getModels} from '../services/codebuddy/api.js';
import {aggregateStreamResponse} from '../services/providers/stream-response.js';
import {
    anthropicToOpenAI,
    injectBehaviorRules,
    openAIToAnthropic
} from '../services/codebuddy/anthropic-adapter.js';
import {
    buildConversationAnchorKey,
    chatResponseToResponses,
    chatResponseToCompact,
    compactRequestToChat,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    extractCacheHitTokens,
    mergeConsecutiveAssistantMessages,
    responsesRequestToChat,
    rewriteOpenAIStream,
    sanitizeAnthropicPayload,
    stripDynamicReminders
} from '../services/codebuddy/protocol-adapter.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {resolveCredential} from '../services/gateway/gateway-auth.js';
import {BLOCKED_DOMAINS, getCodebuddyBaseUrl, isPersonalHost} from '../services/codebuddy/config.js';
import {handleWSConnection} from '../services/shared/responses-ws-server.js';
import logger from '../utils/logger.js';
import {isNetworkError} from '../utils/http-client.js';

/**
 * 基于规则映射 Codex 传入的模型名到 CodeBuddy 实际可用模型
 * - gpt- 开头且不含 mini → kimi-k2.6
 * - gpt- 开头且含 mini，或含 codex → deepseek-v4-flash
 * - 其他保持不变
 */
function mapModelName(model) {
    if (!model || typeof model !== 'string') return model;
    const lower = model.toLowerCase();

    if (lower.startsWith('gpt-') || lower.includes('mini')) {
        return 'deepseek-v4-flash';
    }
    return model;
}

/**
 * 选择用于统计记录的模型名
 * 优先使用上游返回的模型名，但如果上游返回的是端点 ID（ep- 前缀）等不可读标识，
 * 则回退到客户端请求的模型名
 */
function pickModelName(upstreamModel, clientModel) {
    if (upstreamModel && !upstreamModel.startsWith('ep-')) return upstreamModel;
    return clientModel || upstreamModel;
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送 OpenAI 格式的错误响应
 */
function sendOpenAIError(res, status, message, type = 'api_error') {
    if (res.headersSent) {
        try { res.end(); } catch {}
        return;
    }
    const errorResponse = {
        error: {
            message: message,
            type: type,
            code: status
        }
    };
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(errorResponse));
}

/**
 * 发送 Anthropic 格式的错误响应
 */
function sendAnthropicError(res, status, message) {
    const errorResponse = {
        type: 'error',
        error: {
            type: status === 401 ? 'authentication_error' : 'api_error',
            message: message
        }
    };
    sendJson(res, status, errorResponse);
}

function upstreamErrorStatus(err) {
    return isNetworkError(err) ? 502 : 500;
}

/**
 * 从请求头或 payload 消息中提取稳定的会话标识
 *
 * 优先级：x-conversation-id 请求头 > 从 messages 前缀推算的会话指纹
 *
 * 推算策略：用 system、tools、第一条 user 和 tenantId 作为对话锚点，
 * 避免多轮追加消息时 prompt_cache_key 每轮变化。
 * 这确保 prompt_cache_key 在同一对话内保持一致，
 * 让 GLM 等依赖 cache key 做实例路由的厂商能正确复用 KV Cache。
 */
function normalizeConversationId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractConversationIdFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.conversation_id,
        payload.conversationId,
        payload.session_id,
        payload.sessionId,
        payload.thread_id,
        payload.threadId,
        metadata?.conversation_id,
        metadata?.conversationId,
        metadata?.session_id,
        metadata?.sessionId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeConversationId(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

function resolveConversationId(req, messages, payload = {}, meta = {}) {
    // 1. 优先使用客户端显式传入的 conversation-id
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeConversationId(value);
        if (normalized) return normalized;
    }

    const payloadResult = extractConversationIdFromPayload(payload);
    if (payloadResult) return payloadResult;

    const keyMeta = {
        ...meta,
        ...(req.codebuddyClientConnectionId && !meta.clientConnectionId
            ? {clientConnectionId: req.codebuddyClientConnectionId}
            : {})
    };

    const anchorPayload =
        payload && typeof payload === 'object'
            ? {...payload, messages: Array.isArray(messages) ? messages : payload.messages}
            : {messages};
    return buildConversationAnchorKey(anchorPayload, keyMeta);
}

/**
 * 鉴权并获取租户凭证
 * @param {Object} req - 请求对象（必须已通过中间件注入 req.tenantId）
 */
async function authenticateAndGetCredential(req) {
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'CodeBuddy tenant system is not enabled'}};
    }

    // Get the codebuddy credential manager for this tenant
    // This uses the existing TokenManager logic via tenant-manager
    const {credentials, activeIndex} = (await unifiedTenantManager.listCodebuddyCredentials)
        ? await unifiedTenantManager.listCodebuddyCredentials(tenantId)
        : {credentials: [], activeIndex: -1};

    const credential = resolveCredential(req.headers, credentials, activeIndex);

    if (!credential) {
        return {error: {status: 503, message: 'No available credentials for tenant'}};
    }

    return {credential, tenantId};
}

/**
 * 解析请求体
 */
async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function prepareCodebuddyOutboundChatRequest(chatRequest, {model, stream} = {}) {
    if (model) chatRequest.model = model;
    if (stream !== undefined) chatRequest.stream = stream;
    chatRequest.messages = injectBehaviorRules(chatRequest.messages || [], chatRequest.model);
    chatRequest.messages = stripDynamicReminders(chatRequest.messages);
    mergeConsecutiveAssistantMessages(chatRequest.messages);
    return chatRequest;
}

/**
 * 处理 OpenAI 格式的 /v1/chat/completions 请求 - 直接透传
 */
async function handleOpenAIChatCompletions(req, res) {
    let tenantInfo = '';
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (!authResult.error) {
            const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
            if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
        }
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        // 解析 OpenAI 格式的请求
        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        // 映射 Codex 传入的模型名到实际可用模型
        if (openAIPayload.model) {
            openAIPayload.model = mapModelName(openAIPayload.model);
        }

        const conversationId = resolveConversationId(req, openAIPayload.messages, openAIPayload, {
            tenantId: authResult.tenantId
        });

        prepareCodebuddyOutboundChatRequest(openAIPayload);

        // 从 messages 前缀推算稳定的 conversationId，确保同一对话的 prompt_cache_key 一致
        const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        // 直接调用 CodeBuddy API（已经是 OpenAI 格式）
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id'],
            ...tenantMeta
        });

        // 流式响应：对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个块
        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            rewriteOpenAIStream(
                res,
                response.body,
                (inputTokens, outputTokens, cacheHitTokens, credit, model) => {
                    if (authResult.tenantId) {
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
                            pickModelName(model, openAIPayload.model)
                        );
                    }
                },
                undefined,
                {logger}
            );
        } else {
            const aggregated = await aggregateStreamResponse(response.body);

            if (authResult.tenantId) {
                const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
                const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
                const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
                const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
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
                    pickModelName(aggregated.model, openAIPayload.model)
                );
            }

            const openAIResponse = {
                id: aggregated.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
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
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            sendJson(res, 200, openAIResponse);
        }
    } catch (error) {
        logger.error(`Failed to handle OpenAI chat completions${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
    }
}

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
 * 处理 Anthropic 格式的 /v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    let tenantInfo = '';
    try {
        const authResult = await authenticateAndGetCredential(req);
        if (!authResult.error) {
            const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
            if (tenant?.name && tenant?.username) tenantInfo = `${tenant.name}(${tenant.username})`;
        }
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        // 解析 Anthropic 格式的请求
        const body = await parseBody(req);
        const anthropicPayload = sanitizeAnthropicPayload(JSON.parse(body));

        const tenant = unifiedTenantManager.getTenant(authResult.tenantId);
        const tenantMeta = {tenantName: tenant?.name, tenantUsername: tenant?.username};

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        // 映射 Codex 传入的模型名到实际可用模型
        if (openAIPayload.model) {
            openAIPayload.model = mapModelName(openAIPayload.model);
        }

        const conversationId = resolveConversationId(req, anthropicPayload.messages, anthropicPayload, {
            tenantId: authResult.tenantId
        });

        prepareCodebuddyOutboundChatRequest(openAIPayload);

        // 从 messages 前缀推算稳定的 conversationId，确保同一对话的 prompt_cache_key 一致
        // 调用 CodeBuddy API
        const response = await createChatCompletions(openAIPayload, {
            credential: authResult.credential,
            conversationId,
            conversationRequestId: req.headers['x-conversation-request-id'],
            conversationMessageId: req.headers['x-conversation-message-id'],
            requestId: req.headers['x-request-id'],
            ...tenantMeta
        });

        // 判断是否为流式响应
        if (anthropicPayload.stream) {
            // 流式响应
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const chatToAnthropicBridge = createChatToAnthropicStreamBridge({model: anthropicPayload.model});
            let buffer = Buffer.alloc(0);
            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let streamCacheHitTokens = 0;
            let streamCredit = 0;
            let streamModel = '';

            const responseBody = response.body;

            responseBody.on('data', (chunk) => {
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

                    for (const event of chatToAnthropicBridge.feed(data)) {
                        if (res.destroyed) break;
                        res.write(`event: ${event.type}\n`);
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                    }
                }

                if (start > 0) {
                    buffer = buffer.subarray(start);
                }
            });

            responseBody.on('end', () => {
                if (!chatToAnthropicBridge.finished) {
                    for (const event of chatToAnthropicBridge.finish()) {
                        if (res.destroyed) break;
                        res.write(`event: ${event.type}\n`);
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
                        pickModelName(streamModel, anthropicPayload.model)
                    );
                }
                res.end();
            });

            responseBody.on('error', (err) => {
                logger.error(`Stream error${tenantInfo ? `, ${tenantInfo}` : ''}:`, err);
                if (!chatToAnthropicBridge.finished && !res.destroyed) {
                    const errorChunk = {
                        id: 'chatcmpl_error',
                        model: streamModel || anthropicPayload.model,
                        choices: [{
                            delta: {content: `模型请求异常，请稍后重试。\n${err?.message || ''}`},
                            finish_reason: 'stop'
                        }]
                    };
                    for (const event of chatToAnthropicBridge.feed(errorChunk)) {
                        if (res.destroyed) break;
                        res.write(`event: ${event.type}\n`);
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                    }
                }
                res.end();
            });
        } else {
            // 非流式响应
            const aggregated = await aggregateStreamResponse(response.body);

            if (authResult.tenantId) {
                const inputTokens = aggregated.usage ? aggregated.usage.prompt_tokens || 0 : 0;
                const outputTokens = aggregated.usage ? aggregated.usage.completion_tokens || 0 : 0;
                const cacheHitTokens = extractCacheHitTokens(aggregated.usage);
                const credit = aggregated.usage ? aggregated.usage.credit || 0 : 0;
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
                    pickModelName(aggregated.model, anthropicPayload.model)
                );
            }

            const openAIResponse = {
                id: aggregated.id || `msg_${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: aggregated.model || openAIPayload.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: aggregated.content || null,
                            reasoning_content: aggregated.reasoningContent || undefined,
                            tool_calls: aggregated.toolCalls.length > 0 ? aggregated.toolCalls : undefined
                        },
                        finish_reason: aggregated.finishReason || 'stop',
                        logprobs: null
                    }
                ],
                usage: aggregated.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error(`Failed to handle Anthropic messages${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
        sendAnthropicError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
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
async function resolveTenantManager(req) {
    const tenantId = req.tenantId;
    if (!tenantId) return {error: {status: 401, message: 'Unauthorized'}};
    // Use the existing codebuddy tenant-manager for credential operations
    // (still needed until Task 20 extracts credential manager)
    const manager = (await unifiedTenantManager.getCodebuddyCredentialManager)
        ? await unifiedTenantManager.getCodebuddyCredentialManager(tenantId)
        : null;
    if (!manager) return {error: {status: 404, message: 'Tenant credential manager not available'}};
    return {manager, tenantId};
}

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
