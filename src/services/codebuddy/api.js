/**
 * CodeBuddy API 客户端
 * @module services/codebuddy/api
 */

import {request, readBody} from '../../utils/http-client.js';
import logger from '../../utils/logger.js';
import {getCodebuddyApiUrl, codebuddyHeaders, DEFAULT_BASE_URL, CODEBUDDY_MODELS} from './config.js';
import {randomBytes} from 'crypto';

/**
 * 生成不带横线的 UUID（性能优化版本）
 * 比 randomUUID().replace(/-/g, '') 更快
 */
function generateCompactId() {
    return randomBytes(16).toString('hex');
}

/**
 * 生成标准格式 UUID
 */
function generateUUID() {
    const bytes = randomBytes(16);
    // 设置版本 4 和变体
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 获取可用模型列表
 * @returns {Promise<Object>}
 */
export async function getModels(credential = null) {
    if (!credential) {
        throw new Error('No valid CodeBuddy credentials available');
    }

    return {
        data: CODEBUDDY_MODELS,
        object: 'list'
    };
}

/**
 * 创建 chat completions
 * @param {Object} payload - OpenAI 格式的请求体
 * @param {Object} options - 可选参数
 * @returns {Promise<{body: ReadableStream, headers: Object, status: number}>}
 */
export async function createChatCompletions(payload, options = {}) {
    const credential = options.credential;
    if (!credential) {
        throw new Error('No valid CodeBuddy credentials available. Please add credentials or use a valid API key.');
    }

    const bearerToken = credential.bearer_token;
    const userId = credential.user_id;
    const baseUrl = credential.base_url || DEFAULT_BASE_URL;
    const enterpriseId = credential.enterprise_id;
    const departmentInfo = credential.department_info;
    const domain = credential.domain;

    // 生成会话 ID（使用优化后的函数）
    const conversationId = options.conversationId || generateUUID();
    const conversationRequestId = options.conversationRequestId || generateCompactId();
    const conversationMessageId = options.conversationMessageId || generateCompactId();
    const requestId = options.requestId || generateCompactId();

    // 构建请求头
    const headers = codebuddyHeaders(bearerToken, {
        conversationId,
        conversationRequestId,
        conversationMessageId,
        requestId,
        userId,
        enterpriseId,
        departmentInfo,
        domain,
        baseUrl
    });

    // 确保 stream 为 true（CodeBuddy 只支持流式请求）
    const requestPayload = {
        ...payload,
        stream: true
    };

    const url = getCodebuddyApiUrl(baseUrl);
    logger.info(
        `[CodeBuddy]: ${url}, model: ${payload.model}, effort: ${requestPayload.reasoning_effort || 'N/A'}, userId: ${userId}`
    );

    const response = await request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        maxRetries: 3
    });

    if (response.status >= 400) {
        const errorBody = await readBody(response.body);

        // 记录完整的消息历史以便调试
        throw new Error(`CodeBuddy API error: ${response.status} - ${errorBody}`);
    }

    return response;
}

/**
 * 处理 SSE 流式响应
 * @param {ReadableStream} stream
 * @param {Function} onChunk - 处理每个 chunk 的回调
 * @param {Function} onError - 错误回调
 * @returns {Promise<void>}
 */
export async function handleStreamResponse(stream, onChunk, onError) {
    return new Promise((resolve, reject) => {
        let buffer = '';

        stream.on('data', (chunk) => {
            try {
                buffer += chunk.toString('utf8');

                // 处理完整的 SSE 行
                while (buffer.includes('\n')) {
                    const lineEndIndex = buffer.indexOf('\n');
                    const line = buffer.slice(0, lineEndIndex);
                    buffer = buffer.slice(lineEndIndex + 1);

                    const trimmedLine = line.trim();
                    if (!trimmedLine || trimmedLine.startsWith(':')) {
                        continue;
                    }

                    if (trimmedLine.startsWith('data: ')) {
                        const data = trimmedLine.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            onChunk(parsed);
                        } catch {
                            // ignore parse errors
                        }
                    }
                }
            } catch (error) {
                if (onError) {
                    onError(error);
                }
            }
        });

        stream.on('end', () => {
            // 处理缓冲区中剩余的数据
            if (buffer.trim()) {
                const trimmedBuffer = buffer.trim();
                if (trimmedBuffer.startsWith('data: ')) {
                    const data = trimmedBuffer.slice(6);
                    if (data !== '[DONE]') {
                        try {
                            const parsed = JSON.parse(data);
                            onChunk(parsed);
                        } catch {
                            // ignore parse errors
                        }
                    }
                }
            }
            resolve();
        });

        stream.on('error', (error) => {
            if (onError) {
                onError(error);
            }
            reject(error);
        });
    });
}

/**
 * 聚合流式响应为完整响应
 * @param {ReadableStream} stream
 * @returns {Promise<Object>}
 */
export async function aggregateStreamResponse(stream) {
    const aggregator = {
        id: null,
        model: null,
        content: '',
        toolCalls: [],
        finishReason: null,
        usage: null
    };

    // 跟踪工具调用
    const toolCallMap = new Map();
    let currentToolId = null;

    await handleStreamResponse(
        stream,
        (chunk) => {
            // 聚合基本信息
            aggregator.id = aggregator.id || chunk.id;
            aggregator.model = aggregator.model || chunk.model;

            if (chunk.usage) {
                aggregator.usage = chunk.usage;
            }

            const choices = chunk.choices || [];
            if (choices.length === 0) {
                return;
            }

            const choice = choices[0];

            if (choice.finish_reason) {
                aggregator.finishReason = choice.finish_reason;
            }

            const delta = choice.delta || {};

            // 聚合内容
            if (delta.content) {
                aggregator.content += delta.content;
            }

            // 处理工具调用
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const toolId = tc.id;

                    if (toolId) {
                        // 新的工具调用
                        if (!toolCallMap.has(toolId)) {
                            toolCallMap.set(toolId, {
                                id: toolId,
                                type: tc.type || 'function',
                                function: {
                                    name: '',
                                    arguments: ''
                                }
                            });
                            currentToolId = toolId;
                        } else {
                            currentToolId = toolId;
                        }

                        // 更新工具调用信息
                        if (tc.type) {
                            toolCallMap.get(toolId).type = tc.type;
                        }

                        const func = tc.function || {};
                        if (func.name) {
                            toolCallMap.get(toolId).function.name = func.name;
                        }
                        if (func.arguments) {
                            toolCallMap.get(toolId).function.arguments += func.arguments;
                        }
                    } else if (currentToolId && toolCallMap.has(currentToolId)) {
                        // 增量数据
                        const func = tc.function || {};
                        if (func.name) {
                            toolCallMap.get(currentToolId).function.name = func.name;
                        }
                        if (func.arguments) {
                            toolCallMap.get(currentToolId).function.arguments += func.arguments;
                        }
                    }
                }
            }
        },
        (error) => {
            logger.error('Stream processing error:', error);
        }
    );

    // 构建最终响应
    aggregator.toolCalls = Array.from(toolCallMap.values());

    // 验证和修复工具调用参数
    for (const tc of aggregator.toolCalls) {
        try {
            if (tc.function.arguments) {
                JSON.parse(tc.function.arguments);
            }
        } catch (e) {
            // 尝试修复不完整的 JSON
            let args = tc.function.arguments.trim();
            if (!args.endsWith('}') && args.includes('{')) {
                args += '}';
            }
            if (!args.endsWith(']') && args.includes('[')) {
                args += ']';
            }
            try {
                JSON.parse(args);
                tc.function.arguments = args;
            } catch (e2) {
                tc.function.arguments = '{}';
            }
        }
    }

    return aggregator;
}
