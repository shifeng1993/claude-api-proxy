/**
 * Copilot 路由处理器 - 支持 OpenAI 和 Anthropic 双格式的聊天补全和模型列表 API
 * @module routes/copilot
 */

import {authenticateGitHub, ensureCopilotToken, isAuthenticated} from '../services/copilot/auth.js';
import {createChatCompletions, getModels} from '../services/copilot/copilot-api.js';
import {copilotState} from '../services/copilot/state.js';
import {readBody} from '../utils/http-client.js';
import {
    anthropicToOpenAI,
    openAIToAnthropic,
    translateStreamChunk,
    createStreamState
} from '../services/copilot/anthropic-translator.js';
import {
    estimateMessageTokens,
    estimateContentBlockTokens
} from '../utils/token-estimation.js';
import {aggregateStreamResponse} from '../services/codebuddy/api.js';
import logger from '../utils/logger.js';

// 自动认证配置
const AUTO_AUTH = true;

/* ==================== 工具函数 ==================== */

function extractProxyFromHeaders(req) {
    const proxy = req.headers['x-copilot-proxy'];
    // 仅信任来自本地的请求头
    if (!proxy) return undefined;
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        return proxy;
    }
    return undefined;
}

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendOpenAIError(res, status, message, type = 'api_error') {
    sendJson(res, status, {error: {message, type, code: status}});
}

function sendAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendJson(res, status, {type: 'error', error: {type: errorType, message}});
}

async function parseBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/* ==================== 鉴权 ==================== */

async function ensureAuthenticated() {
    if (isAuthenticated()) {
        return true;
    }

    if (AUTO_AUTH) {
        logger.warn('Not authenticated. Please run the service once to complete GitHub authentication.');
        return false;
    }

    logger.warn('Not authenticated. Please authenticate first.');
    return false;
}

async function authenticateAndGetToken(proxyUrl) {
    if (!(await ensureAuthenticated())) {
        return {error: {status: 401, message: 'Not authenticated. Please complete GitHub authentication first.'}};
    }

    try {
        const copilotToken = await ensureCopilotToken(proxyUrl);
        return {copilotToken};
    } catch (error) {
        return {error: {status: 503, message: error.message}};
    }
}

/* ==================== OpenAI 模式 ==================== */

/**
 * 处理 OpenAI 格式的 /copilot/v1/chat/completions 请求
 */
async function handleOpenAIChatCompletions(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(proxyUrl);
        if (authResult.error) {
            sendOpenAIError(
                res,
                authResult.error.status,
                authResult.error.message,
                authResult.error.status === 401 ? 'authentication_error' : 'api_error'
            );
            return;
        }

        const body = await parseBody(req);
        const openAIPayload = JSON.parse(body);

        logger.info(`Copilot OpenAI request - model: ${openAIPayload.model}, stream: ${openAIPayload.stream}`);

        const response = await createChatCompletions(
            copilotState.copilotToken,
            copilotState.vsCodeVersion,
            openAIPayload,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendOpenAIError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        if (openAIPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            let streamInputTokens = 0;
            let streamOutputTokens = 0;
            let lineBuffer = '';

            response.body.on('data', (chunk) => {
                res.write(chunk);
                lineBuffer += chunk.toString('utf8');
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const raw = trimmed.slice(6).trim();
                    if (raw === '[DONE]') continue;
                    try {
                        const data = JSON.parse(raw);
                        if (data.usage) {
                            streamInputTokens = data.usage.prompt_tokens || 0;
                            streamOutputTokens = data.usage.completion_tokens || 0;
                        }
                    } catch {}
                }
            });

            response.body.on('end', () => {
                if (lineBuffer.trim()) {
                    res.write(lineBuffer);
                }
                res.end();
            });

            response.body.on('error', (err) => {
                logger.error('Copilot OpenAI stream error:', err);
                res.end();
            });

            res.on('close', () => {
                if (response.body && !response.body.destroyed) {
                    response.body.destroy();
                }
            });
        } else {
            const responseBody = await readBody(response.body);
            let parsed;
            try {
                parsed = JSON.parse(responseBody);
            } catch {
                sendOpenAIError(res, 502, 'Upstream returned invalid JSON');
                return;
            }
            sendJson(res, 200, parsed);
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle OpenAI chat completions:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 OpenAI 格式的 /copilot/v1/models 请求
 */
async function handleOpenAIModels(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(proxyUrl);
        if (authResult.error) {
            sendOpenAIError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot'
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get OpenAI models:', error);
        sendOpenAIError(res, 500, error.message || 'Internal server error');
    }
}

/* ==================== Anthropic 模式 ==================== */

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages 请求
 */
async function handleAnthropicMessages(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(proxyUrl);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        logger.info(`Copilot Anthropic request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        const response = await createChatCompletions(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            openAIPayload,
            copilotState.accountType,
            proxyUrl
        );

        if (response.status >= 400) {
            const errorBody = await readBody(response.body);
            sendAnthropicError(res, response.status, `Upstream error: ${errorBody.slice(0, 500)}`);
            return;
        }

        if (anthropicPayload.stream) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const state = createStreamState();
            let buffer = '';

            const processLines = (lines) => {
                for (const line of lines) {
                    if (res.destroyed) return;

                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const openAIChunk = JSON.parse(data);
                            const anthropicEvents = translateStreamChunk(openAIChunk, state);

                            for (const event of anthropicEvents) {
                                if (res.destroyed) return;
                                res.write(`event: ${event.type}\n`);
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                            }
                        } catch (e) {
                            logger.error('Failed to parse chunk:', e);
                        }
                    }
                }
            };

            response.body.on('data', (chunk) => {
                try {
                    if (res.destroyed) return;

                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    processLines(lines);
                } catch (error) {
                    logger.error('Stream processing error:', error);
                }
            });

            response.body.on('end', () => {
                if (buffer.trim()) {
                    try {
                        processLines([buffer]);
                    } catch (error) {
                        logger.error('Failed to process remaining buffer:', error);
                    }
                    buffer = '';
                }
                if (!res.destroyed) {
                    res.end();
                }
            });

            response.body.on('error', (error) => {
                logger.error('Stream error:', error);
                if (!res.destroyed) {
                    res.end();
                }
            });

            res.on('close', () => {
                if (response.body && !response.body.destroyed) {
                    response.body.destroy();
                }
            });
        } else {
            const responseBody = await readBody(response.body);
            const openAIResponse = JSON.parse(responseBody);
            const anthropicResponse = openAIToAnthropic(openAIResponse);
            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Copilot: Failed to handle Anthropic messages:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/messages/count_tokens
 */
async function handleAnthropicCountTokens(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(proxyUrl);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const body = await parseBody(req);
        const anthropicPayload = JSON.parse(body);

        let totalTokens = 0;

        if (Array.isArray(anthropicPayload.messages)) {
            totalTokens += estimateMessageTokens(anthropicPayload.messages);
        }

        if (anthropicPayload.system) {
            if (typeof anthropicPayload.system === 'string') {
                totalTokens += Math.ceil(anthropicPayload.system.length / 4);
            } else if (Array.isArray(anthropicPayload.system)) {
                for (const block of anthropicPayload.system) {
                    totalTokens += estimateContentBlockTokens(block);
                }
            }
        }

        if (Array.isArray(anthropicPayload.tools)) {
            for (const tool of anthropicPayload.tools) {
                totalTokens += Math.ceil((tool.name || '').length / 4);
                totalTokens += Math.ceil((tool.description || '').length / 4);
                if (tool.input_schema) {
                    const schemaStr = JSON.stringify(tool.input_schema);
                    totalTokens += Math.ceil(schemaStr.length / 2);
                }
            }
        }

        sendJson(res, 200, {input_tokens: totalTokens});
    } catch (error) {
        logger.error('Copilot: Failed to count tokens:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 Anthropic 格式的 /copilot/anthropic/v1/models
 */
async function handleAnthropicModels(req, res) {
    try {
        const proxyUrl = extractProxyFromHeaders(req);
        const authResult = await authenticateAndGetToken(proxyUrl);
        if (authResult.error) {
            sendAnthropicError(res, authResult.error.status, authResult.error.message);
            return;
        }

        const modelsData = await getModels(
            authResult.copilotToken,
            copilotState.vsCodeVersion,
            copilotState.accountType,
            proxyUrl
        );

        sendJson(res, 200, {
            object: 'list',
            data: (modelsData.data || []).map((model) => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot',
                name: model.name,
                capabilities: model.capabilities || {}
            }))
        });
    } catch (error) {
        logger.error('Copilot: Failed to get Anthropic models:', error);
        sendAnthropicError(res, 500, error.message || 'Internal server error');
    }
}

/* ==================== 根路径 ==================== */

function handleRoot(req, res) {
    sendJson(res, 200, {
        name: 'GitHub Copilot API Proxy',
        version: '1.0.0',
        modes: ['openai', 'anthropic'],
        authenticated: isAuthenticated(),
        user: copilotState.userInfo,
        endpoints: {
            openai: {
                chatCompletions: 'POST /copilot/v1/chat/completions - OpenAI format',
                models: 'GET /copilot/v1/models - OpenAI format models'
            },
            anthropic: {
                messages: 'POST /copilot/anthropic/v1/messages - Claude format',
                countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                models: 'GET /copilot/anthropic/v1/models - Claude format models'
            }
        },
        configuration: {
            autoAuth: AUTO_AUTH,
            tokenSource: isAuthenticated() ? '.copilot/github_token' : 'not configured'
        }
    });
}

/* ==================== 主路由 ==================== */

export async function routeCopilotRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    logger.info(`Copilot request: ${method} ${pathname}`);

    // ========== Anthropic 模式 ==========
    if (pathname.startsWith('/copilot/anthropic')) {
        const anthropicPath = pathname.replace('/copilot/anthropic', '');

        if (anthropicPath === '' || anthropicPath === '/') {
            sendJson(res, 200, {
                name: 'Copilot API Proxy - Anthropic Mode',
                version: '1.0.0',
                endpoints: {
                    messages: 'POST /copilot/anthropic/v1/messages',
                    countTokens: 'POST /copilot/anthropic/v1/messages/count_tokens',
                    models: 'GET /copilot/anthropic/v1/models'
                }
            });
            return;
        }

        if (anthropicPath === '/v1/messages' && method === 'POST') return handleAnthropicMessages(req, res);
        if (anthropicPath === '/v1/messages/count_tokens' && method === 'POST') return handleAnthropicCountTokens(req, res);
        if (anthropicPath === '/v1/models' && method === 'GET') return handleAnthropicModels(req, res);

        sendAnthropicError(res, 404, 'Endpoint not found');
        return;
    }

    // ========== OpenAI 模式 ==========
    if (pathname === '/copilot/v1/chat/completions' && method === 'POST') return handleOpenAIChatCompletions(req, res);
    if (pathname === '/copilot/v1/models' && method === 'GET') return handleOpenAIModels(req, res);

    // ========== 根路径 ==========
    if (pathname === '/copilot' || pathname === '/copilot/') return handleRoot(req, res);

    sendOpenAIError(res, 404, 'Endpoint not found');
}
