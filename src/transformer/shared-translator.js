/**
 * 公共 Translator 逻辑
 * 抽取自 Copilot/CodeBuddy translator 的重复代码
 * @module transformer/shared-translator
 */

import {randomBytes} from 'crypto';
import logger from '../utils/logger.js';
import {getBehaviorRules} from '../config/system-prompts.js';

/**
 * 生成唯一 ID
 */
export function generateId() {
    return randomBytes(16).toString('hex');
}

/**
 * 映射 OpenAI stop reason 到 Anthropic 格式
 */
export function mapStopReason(finishReason) {
    const mapping = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'end_turn'
    };
    return mapping[finishReason] || null;
}

/**
 * 转换 tool_choice
 */
export function translateToolChoice(anthropicToolChoice) {
    if (!anthropicToolChoice) {
        return undefined;
    }

    if (anthropicToolChoice.type === 'auto') {
        return 'auto';
    }
    if (anthropicToolChoice.type === 'any') {
        return 'required';
    }
    if (anthropicToolChoice.type === 'tool') {
        return {
            type: 'function',
            function: {name: anthropicToolChoice.name}
        };
    }

    return undefined;
}

/**
 * 将 base64 编码的文档内容解码为文本
 * 支持 PDF、纯文本、代码文件等
 */
function decodeDocumentToText(block) {
    const source = block.source;
    if (!source || source.type !== 'base64' || !source.data) {
        return null;
    }

    const mediaType = (source.media_type || '').toLowerCase();

    // 纯文本类文件：直接 base64 解码
    const textMediaTypes = [
        'text/plain',
        'text/markdown',
        'text/csv',
        'text/html',
        'text/xml',
        'text/css',
        'text/javascript',
        'text/x-python',
        'text/x-java',
        'text/x-c',
        'text/x-cpp',
        'text/x-shellscript',
        'text/x-yaml',
        'text/x-json',
        'text/x-toml',
        'text/x-rust',
        'application/json',
        'application/xml',
        'application/javascript',
        'application/x-yaml',
        'application/x-sh'
    ];
    if (textMediaTypes.includes(mediaType)) {
        try {
            return Buffer.from(source.data, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }

    // PDF: 尝试提取文本，失败则回退为 base64 image_url
    if (mediaType === 'application/pdf') {
        try {
            const pdfBuffer = Buffer.from(source.data, 'base64');
            const text = extractPDFText(pdfBuffer);
            if (text && text.trim().length > 0) {
                return text;
            }
        } catch {
            // PDF 文本提取失败，回退
        }
        return null;
    }

    // 未知类型：尝试 base64 解码为文本
    try {
        const decoded = Buffer.from(source.data, 'base64').toString('utf8');
        const nonPrintable = decoded.split('').filter((c) => {
            const code = c.charCodeAt(0);
            return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
        }).length;
        if (nonPrintable / decoded.length < 0.1) {
            return decoded;
        }
    } catch {}

    return null;
}

/**
 * 从 PDF Buffer 中提取纯文本
 * 使用简单的正则匹配方式，无需外部依赖
 */
function extractPDFText(buffer) {
    const text = buffer.toString('latin1');

    const texts = [];
    const parenRegex = /\(([^\\)]*(?:\\.[^\\)]*)*)\)/g;
    let match;
    while ((match = parenRegex.exec(text)) !== null) {
        const raw = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
        if (raw.trim().length > 0) {
            texts.push(raw);
        }
    }

    return texts.join('\n');
}

/**
 * 映射内容块
 * 支持 text、image、document（PDF/文本文件）类型
 */
export function mapContent(blocks) {
    if (blocks.length === 1 && blocks[0].type === 'text') {
        return blocks[0].text;
    }

    const mapped = blocks
        .map((block) => {
            if (block.type === 'text') {
                return {type: 'text', text: block.text};
            }
            if (block.type === 'image') {
                return {
                    type: 'image_url',
                    image_url: {
                        url:
                            block.source.type === 'base64'
                                ? `data:${block.source.media_type};base64,${block.source.data}`
                                : block.source.url
                    }
                };
            }
            if (block.type === 'document') {
                const extractedText = decodeDocumentToText(block);
                if (extractedText) {
                    return {type: 'text', text: extractedText};
                }
                const source = block.source;
                if (source && source.type === 'base64' && source.data) {
                    return {
                        type: 'image_url',
                        image_url: {
                            url: `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`
                        }
                    };
                }
                return null;
            }
            if (block.text) {
                return {type: 'text', text: block.text};
            }
            return null;
        })
        .filter(Boolean);

    if (mapped.length === 0) {
        return '';
    }

    return mapped;
}

/**
 * 在用户消息前注入中文思考引导语，防止多轮对话后思考语言漂移
 */
export function prependThinkingHint(content) {
    if (typeof content === 'string') {
        return '[重要提醒：你的思考过程必须使用中文，不要用英文思考！]\n' + content;
    }
    return content;
}

/**
 * 在工具返回结果中注入中文思考引导语，防止工具调用后思考语言漂移到英文
 */
export function prependToolThinkingHint(content) {
    if (typeof content === 'string') {
        return '[重要：工具返回结果必须用中文分析和思考！]\n' + content;
    }
    return content;
}

/**
 * 在 assistant 消息后注入中文思考提醒，防止下一轮思考语言漂移到英文
 */
const THINKING_LANG_REMINDER = {role: 'system', content: '[关键规则] 你的思考过程必须使用中文！不要用英文思考！'};

/**
 * 将行为规则注入到 OpenAI 格式的 messages 数组中
 * 如果存在 system 消息则前置，否则新建
 * 同时在每条 assistant 消息后插入中文思考提醒
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @returns {Array} 注入后的 messages 数组
 */
export function injectBehaviorRules(messages) {
    const behaviorRules = getBehaviorRules();
    const result = [];

    const systemIndex = messages.findIndex((m) => m.role === 'system');

    // 注入前置 system 规则
    if (systemIndex >= 0) {
        result.push({
            ...messages[systemIndex],
            content: behaviorRules + '\n\n' + messages[systemIndex].content
        });
    } else {
        result.push({role: 'system', content: behaviorRules});
    }

    // 在每条 assistant 消息后插入中文思考提醒
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (i === systemIndex) continue;

        result.push(m);

        // fix: deepseek和kimi不能在工具调用的消息插入系统提示词，会导致消息块顺序错误
        if (m.role === 'assistant' && !m.tool_calls) {
            result.push({...THINKING_LANG_REMINDER});
        }
    }

    return result;
}

/**
 * 转换 OpenAI 响应到 Anthropic 格式
 */
export function openAIToAnthropic(openAIResponse) {
    const choice = openAIResponse.choices?.[0];
    if (!choice) {
        return {
            id: openAIResponse.id || generateId(),
            type: 'message',
            role: 'assistant',
            model: openAIResponse.model || 'unknown',
            content: [{type: 'text', text: 'Empty response from upstream API'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: openAIResponse.usage?.prompt_tokens || 0,
                output_tokens: openAIResponse.usage?.completion_tokens || 0
            }
        };
    }

    const message = choice.message || {};
    const content = [];

    if (message.content) {
        content.push({
            type: 'text',
            text: message.content
        });
    }

    if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
            let parsedInput = {};
            try {
                parsedInput = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                logger.warn('Failed to parse tool call arguments:', toolCall.function?.arguments?.slice(0, 200));
                parsedInput = {};
            }
            content.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input: parsedInput
            });
        }
    }

    if (content.length === 0) {
        content.push({type: 'text', text: ''});
    }

    return {
        id: openAIResponse.id,
        type: 'message',
        role: 'assistant',
        model: openAIResponse.model,
        content: content,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openAIResponse.usage?.prompt_tokens || 0,
            output_tokens: openAIResponse.usage?.completion_tokens || 0
        }
    };
}
