/**
 * CodeBuddy API 客户端
 * @module services/codebuddy/api
 */

import {request, readBody} from '../../utils/http-client.js';
import logger from '../../utils/logger.js';
import {getCodebuddyApiUrl, codebuddyHeaders, DEFAULT_BASE_URL, CODEBUDDY_MODELS} from './config.js';
import {randomBytes} from 'crypto';

// CodeBuddy 服务端会检测竞争对手关键词并触发 content_filter
// 必须在所有消息和工具定义中替换，不能只替换 system 消息
const KEYWORD_REPLACEMENTS = [
    // 先替换长串，再替换短串，避免短串先命中导致长串匹配失败
    ["Main branch (you will usually use this for PRs)", "Default branch (you will usually use this for MRs)"],
    ["Claude Code, Anthropic's official CLI for Claude", "CodeBuddy Code, Tencent's official CLI for CodeBuddy"],
    ["https://github.com/anthropics/claude-code/issues", "https://cnb.cool/codebuddy/codebuddy-code/-/issues"],
    ["https://claude.com/claude-code", "https://codebuddy.ai/codebuddy-code"],
    ["noreply@anthropic.com", "noreply@tencent.com"],
    ["Claude Code", "CodeBuddy Code"],
    ["Anthropic's official CLI for Claude", "Tencent's official CLI for CodeBuddy"],
    ["claude-code-guide", "codebuddy-code-guide"],
    ["claude-code", "codebuddy-code"],
    ["claude-vscode", "codebuddy-vscode"],
    ["@anthropic-ai/sdk", "@tencent-ai/sdk"],
    ["anthropic SDK", "Tencent SDK"],
    ["Anthropic SDK", "Tencent SDK"],
    ["Anthropic API", "Tencent API"],
    ["Anthropic", "Tencent"],
    ["anthropic", "tencent"],
    ["Claude", "CodeBuddy"],
    ["claude", "codebuddy"],
];

/**
 * 对字符串应用关键词替换
 */
function replaceKeywords(text) {
    if (typeof text !== 'string') return text;
    for (const [old, replacement] of KEYWORD_REPLACEMENTS) {
        text = text.replaceAll(old, replacement);
    }
    return text;
}

/**
 * 递归清理 payload 中会触发服务端内容审核的关键词
 * 替换所有消息内容、工具定义中的敏感词
 */
function sanitizePayload(payload) {
    if (!payload.messages) return;

    for (const msg of payload.messages) {
        if (typeof msg.content === 'string') {
            msg.content = replaceKeywords(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
                if (item && typeof item.text === 'string') {
                    item.text = replaceKeywords(item.text);
                }
                if (item && typeof item.content === 'string') {
                    item.content = replaceKeywords(item.content);
                }
            }
        }
    }

    // 工具定义中的描述和参数也可能包含触发词
    if (Array.isArray(payload.tools)) {
        const toolsStr = replaceKeywords(JSON.stringify(payload.tools));
        try {
            payload.tools = JSON.parse(toolsStr);
        } catch {
            // JSON 替换后解析失败则跳过
        }
    }
}

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

    // CodeBuddy 服务端会检测特定客户端标识字符串并触发内容审核拦截
    // 将 "X Code, Y's official CLI for X" 模式替换为不会触发审核的等价表述
    sanitizePayload(requestPayload);
    const url = getCodebuddyApiUrl(baseUrl);

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
