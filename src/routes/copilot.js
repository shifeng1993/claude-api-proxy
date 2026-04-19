/**
 * Copilot 路由处理器 - Claude Code 兼容模式
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
import logger from '../utils/logger.js';

// 自动认证配置
const AUTO_AUTH = true; // 默认启用

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 */
function sendError(res, status, message) {
    const errorResponse = {
        type: 'error',
        error: {
            type: 'api_error',
            message: message
        }
    };
    sendJson(res, status, errorResponse);
}

/**
 * 确保已认证（支持自动认证）
 */
async function ensureAuthenticated() {
    if (isAuthenticated()) {
        return true;
    }

    // 如果启用自动认证且未认证，提示用户
    if (AUTO_AUTH) {
        logger.warn('Not authenticated. Please run the service once to complete GitHub authentication.');
        logger.warn('After authentication, the token will be saved to .copilot/github_token automatically.');
        return false;
    }

    logger.warn('Not authenticated. Please authenticate first.');
    return false;
}

/**
 * 处理 /v1/messages - Claude Code 主要端点
 */
async function handleMessages(req, res) {
    try {
        // 确保已认证
        if (!(await ensureAuthenticated())) {
            sendError(
                res,
                401,
                'Not authenticated. Please complete GitHub authentication first by running the service and following the prompts.'
            );
            return;
        }

        // 获取 Copilot token
        const copilotToken = await ensureCopilotToken();

        // 解析 Anthropic 格式的请求
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const anthropicPayload = JSON.parse(body);

        logger.info(`Messages request - model: ${anthropicPayload.model}, stream: ${anthropicPayload.stream}`);

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);

        // 调用 Copilot API
        const response = await createChatCompletions(
            copilotToken,
            copilotState.vsCodeVersion,
            openAIPayload,
            copilotState.accountType
        );

        // 判断是否为流式响应
        if (anthropicPayload.stream) {
            // 流式响应
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive'
            });

            const state = createStreamState();
            let buffer = ''; // 用于累积不完整的行

            // 处理缓冲区中的 SSE 行
            const processLines = (lines) => {
                for (const line of lines) {
                    // 客户端已断开，停止处理
                    if (res.destroyed) return;

                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const openAIChunk = JSON.parse(data);

                            // 转换为 Anthropic 事件
                            const anthropicEvents = translateStreamChunk(openAIChunk, state);

                            // 发送每个事件
                            for (const event of anthropicEvents) {
                                if (res.destroyed) return;
                                res.write(`event: ${event.type}\n`);
                                res.write(`data: ${JSON.stringify(event)}\n\n`);
                            }
                        } catch (e) {
                            logger.error('Failed to parse chunk:', e);
                            logger.error('Problematic data:', data);
                        }
                    }
                }
            };

            response.body.on('data', (chunk) => {
                try {
                    if (res.destroyed) return;

                    // 将新数据添加到缓冲区
                    buffer += chunk.toString('utf8');

                    // 按行分割，保留最后一个可能不完整的行
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // 保存最后一个不完整的行

                    processLines(lines);
                } catch (error) {
                    logger.error('Stream processing error:', error);
                }
            });

            response.body.on('end', () => {
                // 处理 buffer 中残留的最后一行数据
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

            // 监听客户端断开连接，及时清理上游流
            res.on('close', () => {
                if (response.body && !response.body.destroyed) {
                    response.body.destroy();
                }
            });
        } else {
            // 非流式响应
            const responseBody = await readBody(response.body);
            const openAIResponse = JSON.parse(responseBody);

            // 转换为 Anthropic 格式
            const anthropicResponse = openAIToAnthropic(openAIResponse);

            sendJson(res, 200, anthropicResponse);
        }
    } catch (error) {
        logger.error('Failed to handle messages:', error);
        sendError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 /v1/messages/count_tokens - Token 计数端点
 */
async function handleCountTokens(req, res) {
    try {
        // 确保已认证
        if (!(await ensureAuthenticated())) {
            sendError(res, 401, 'Not authenticated. Please complete GitHub authentication first.');
            return;
        }

        // 解析请求
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const anthropicPayload = JSON.parse(body);

        // 使用 token 估算工具进行计数
        let totalTokens = 0;

        // 估算 messages 的 tokens
        if (Array.isArray(anthropicPayload.messages)) {
            totalTokens += estimateMessageTokens(anthropicPayload.messages);
        }

        // 估算 system 的 tokens（可以是字符串或内容块数组）
        if (anthropicPayload.system) {
            if (typeof anthropicPayload.system === 'string') {
                totalTokens += Math.ceil(anthropicPayload.system.length / 4);
            } else if (Array.isArray(anthropicPayload.system)) {
                for (const block of anthropicPayload.system) {
                    totalTokens += estimateContentBlockTokens(block);
                }
            }
        }

        // 估算 tools 的 tokens
        if (Array.isArray(anthropicPayload.tools)) {
            for (const tool of anthropicPayload.tools) {
                // Tool name and description
                totalTokens += Math.ceil((tool.name || '').length / 4);
                totalTokens += Math.ceil((tool.description || '').length / 4);
                // Tool input_schema (JSON structure)
                if (tool.input_schema) {
                    const schemaStr = JSON.stringify(tool.input_schema);
                    totalTokens += Math.ceil(schemaStr.length / 2); // JSON has higher density
                }
            }
        }

        sendJson(res, 200, {
            input_tokens: totalTokens
        });
    } catch (error) {
        logger.error('Failed to count tokens:', error);
        sendError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理 /v1/models - 获取可用模型列表
 */
async function handleModels(req, res) {
    try {
        // 确保已认证
        if (!(await ensureAuthenticated())) {
            sendError(res, 401, 'Not authenticated. Please complete GitHub authentication first.');
            return;
        }

        // 获取 Copilot token
        const copilotToken = await ensureCopilotToken();
        
        // 获取模型列表
        const modelsData = await getModels(
            copilotToken, 
            copilotState.vsCodeVersion, 
            copilotState.accountType
        );
        
        const modelsList = modelsData.data || [];
        logger.info(`Retrieved ${modelsList.length} models`);

        // 直接返回 Copilot API 的模型列表
        sendJson(res, 200, {
            object: 'list',
            data: modelsList.map(model => ({
                id: model.id,
                object: 'model',
                created: 0,
                owned_by: model.vendor || 'copilot',
                name: model.name,
                version: model.version,
                capabilities: model.capabilities
            }))
        });
    } catch (error) {
        logger.error('Failed to get models:', error);
        sendError(res, 500, error.message || 'Internal server error');
    }
}

/**
 * 处理根路径 - 服务信息
 */
function handleRoot(req, res) {
    sendJson(res, 200, {
        name: 'GitHub Copilot API Proxy',
        version: '1.0.0',
        mode: 'Claude Code Compatible',
        authenticated: isAuthenticated(),
        user: copilotState.userInfo,
        endpoints: {
            messages: 'POST /copilot/v1/messages - Claude Code messages endpoint',
            countTokens: 'POST /copilot/v1/messages/count_tokens - Token counting',
            models: 'GET /copilot/v1/models - List available models'
        },
        configuration: {
            autoAuth: AUTO_AUTH,
            tokenSource: isAuthenticated() ? '.copilot/github_token' : 'not configured'
        }
    });
}

/**
 * 主路由处理函数
 */
export async function routeCopilotRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    logger.info(`Copilot request: ${req.method} ${pathname}`);

    // Claude Code 端点
    if (pathname === '/copilot/v1/messages' && req.method === 'POST') {
        return handleMessages(req, res);
    }

    if (pathname === '/copilot/v1/messages/count_tokens' && req.method === 'POST') {
        return handleCountTokens(req, res);
    }

    // 模型列表端点
    if (pathname === '/copilot/v1/models' && req.method === 'GET') {
        return handleModels(req, res);
    }

    // 根路径信息
    if (pathname === '/copilot' || pathname === '/copilot/') {
        return handleRoot(req, res);
    }

    // 未找到路由
    sendError(res, 404, 'Endpoint not found');
}
