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
        logger.debug('Anthropic payload:', JSON.stringify(anthropicPayload).slice(0, 500));

        // 转换为 OpenAI 格式
        const openAIPayload = anthropicToOpenAI(anthropicPayload);
        logger.debug('OpenAI payload:', JSON.stringify(openAIPayload).slice(0, 500));

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

            response.body.on('data', (chunk) => {
                try {
                    // 将新数据添加到缓冲区
                    buffer += chunk.toString('utf8');
                    
                    // 按行分割，保留最后一个可能不完整的行
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // 保存最后一个不完整的行

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const data = trimmedLine.slice(6);

                            if (data === '[DONE]') {
                                continue;
                            }

                            try {
                                const openAIChunk = JSON.parse(data);
                                logger.debug('OpenAI chunk:', JSON.stringify(openAIChunk));

                                // 转换为 Anthropic 事件
                                const anthropicEvents = translateStreamChunk(openAIChunk, state);

                                // 发送每个事件
                                for (const event of anthropicEvents) {
                                    logger.debug('Anthropic event:', JSON.stringify(event));
                                    res.write(`event: ${event.type}\n`);
                                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                                }
                            } catch (e) {
                                logger.error('Failed to parse chunk:', e);
                                logger.error('Problematic data:', data);
                            }
                        }
                    }
                } catch (error) {
                    logger.error('Stream processing error:', error);
                }
            });

            response.body.on('end', () => {
                res.end();
            });

            response.body.on('error', (error) => {
                logger.error('Stream error:', error);
                res.end();
            });
        } else {
            // 非流式响应
            const responseBody = await readBody(response.body);
            const openAIResponse = JSON.parse(responseBody);
            logger.debug('OpenAI response:', JSON.stringify(openAIResponse));

            // 转换为 Anthropic 格式
            const anthropicResponse = openAIToAnthropic(openAIResponse);
            logger.debug('Anthropic response:', JSON.stringify(anthropicResponse));

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

        // 简单估算 tokens（Claude Code 会调用这个接口）
        // 实际的 token 计数比较复杂，这里提供一个简化版本
        const text = JSON.stringify(anthropicPayload.messages);
        const estimatedTokens = Math.ceil(text.length / 4); // 粗略估算

        sendJson(res, 200, {
            input_tokens: estimatedTokens
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
        
        logger.info(`Retrieved ${modelsData.data?.length || 0} models`);
        
        // 直接返回 Copilot API 的模型列表
        sendJson(res, 200, {
            object: 'list',
            data: modelsData.data.map(model => ({
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
