/**
 * 公共 Translator 逻辑
 * 抽取自 Copilot translator 的公共代码
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
 * 映射内容块
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
        return '【请用中文思考】\n' + content;
    }
    return content;
}

/**
 * 在工具返回结果中注入中文思考引导语，防止工具调用后思考语言漂移到英文
 */
export function prependToolThinkingHint(content) {
    if (typeof content === 'string') {
        return '【请用中文分析以上工具结果】\n' + content;
    }
    return content;
}

/**
 * 将行为规则注入到 OpenAI 格式的 messages 数组中
 * 如果存在 system 消息则追加，否则新建
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @returns {Array} 注入后的 messages 数组
 */
export function injectBehaviorRules(messages) {
    const behaviorRules = getBehaviorRules();
    const result = [...messages];

    const systemIndex = result.findIndex((m) => m.role === 'system');

    if (systemIndex >= 0) {
        result[systemIndex] = {
            ...result[systemIndex],
            content: result[systemIndex].content + '\n\n' + behaviorRules
        };
    } else {
        result.unshift({role: 'system', content: behaviorRules});
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
