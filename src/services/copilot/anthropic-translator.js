/**
 * Anthropic 到 OpenAI 格式转换模块
 * 用于 Claude Code 兼容性
 * @module services/copilot/anthropic-translator
 */

import logger from '../../utils/logger.js';
import {generateId, mapStopReason, translateToolChoice, mapContent, injectBehaviorRules, prependThinkingHint, prependToolThinkingHint, openAIToAnthropic as sharedOpenAIToAnthropic} from '../../transformer/shared-translator.js';

/**
 * 转换 Anthropic 请求到 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicPayload) {
    const openAIPayload = {
        model: translateModelName(anthropicPayload.model),
        messages: translateMessages(anthropicPayload.messages, anthropicPayload.system),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    // 转换 tools
    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicPayload.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema
            }
        }));
    }

    // 转换 tool_choice
    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    return openAIPayload;
}

/**
 * 转换模型名称
 */
function translateModelName(model) {
    // 处理特殊的子代理模型名称
    if (model.startsWith('claude-sonnet-4-')) {
        return model.replace(/^claude-sonnet-4-.*/, 'claude-sonnet-4');
    }
    if (model.startsWith('claude-opus-4-')) {
        return model.replace(/^claude-opus-4-.*/, 'claude-opus-4');
    }
    return model;
}

/**
 * 转换消息列表
 */
function translateMessages(anthropicMessages, system) {
    const messages = [];

    // 处理 system message（不注入行为规则，最后统一注入）
    if (system) {
        if (typeof system === 'string') {
            messages.push({ role: 'system', content: system });
        } else if (Array.isArray(system)) {
            const systemText = system
                .map(block => block.text)
                .filter(Boolean)
                .join('\n\n');
            if (systemText) {
                messages.push({ role: 'system', content: systemText });
            }
        }
    }

    // 处理其他消息
    if (!Array.isArray(anthropicMessages)) {
        return injectBehaviorRules(messages);
    }

    for (const message of anthropicMessages) {
        if (message.role === 'user') {
            messages.push(...handleUserMessage(message));
        } else {
            messages.push(...handleAssistantMessage(message));
        }
    }

    return injectBehaviorRules(messages);
}

/**
 * 处理用户消息
 */
function handleUserMessage(message) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({ role: 'user', content: prependThinkingHint(message.content) });
    } else if (Array.isArray(message.content)) {
        // 分离 tool_result 和其他内容
        const toolResults = message.content.filter(block => block.type === 'tool_result');
        const otherBlocks = message.content.filter(block => block.type !== 'tool_result');

        // tool_result 必须先处理，注入中文思考引导
        for (const block of toolResults) {
            let content = '';
            if (typeof block.content === 'string') {
                content = block.content;
            } else if (block.content != null) {
                content = JSON.stringify(block.content);
            }
            messages.push({
                role: 'tool',
                tool_call_id: block.tool_use_id,
                content: prependToolThinkingHint(content)
            });
        }

        // 处理其他内容，注入思考引导
        if (otherBlocks.length > 0) {
            messages.push({
                role: 'user',
                content: prependThinkingHint(mapContent(otherBlocks))
            });
        }
    }

    return messages;
}

/**
 * 处理助手消息
 */
function handleAssistantMessage(message) {
    if (typeof message.content === 'string') {
        return [{ role: 'assistant', content: message.content }];
    }

    if (!Array.isArray(message.content)) {
        return [{ role: 'assistant', content: null }];
    }

    // 提取不同类型的块
    const toolUseBlocks = message.content.filter(block => block.type === 'tool_use');
    const textBlocks = message.content.filter(block => block.type === 'text');
    const thinkingBlocks = message.content.filter(block => block.type === 'thinking');

    // 合并文本和思考内容
    const allText = [
        ...textBlocks.map(b => b.text),
        ...thinkingBlocks.map(b => b.thinking)
    ].filter(Boolean).join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || null
    };

    // 添加 tool_calls
    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map(block => ({
            id: block.id,
            type: 'function',
            function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
            }
        }));
    }

    return [result];
}

/**
 * 创建流状态
 */
export function createStreamState() {
    return {
        messageStartSent: false,
        contentBlockOpen: false,
        contentBlockIndex: 0,
        toolCalls: {},
        currentBlockType: null
    };
}

/**
 * 转换流式响应块
 */
export function translateStreamChunk(openAIChunk, state) {
    const events = [];

    if (!openAIChunk.choices || openAIChunk.choices.length === 0) {
        return events;
    }

    const choice = openAIChunk.choices[0];
    const delta = choice.delta;

    // 发送 message_start
    if (!state.messageStartSent) {
        events.push({
            type: 'message_start',
            message: {
                id: openAIChunk.id,
                type: 'message',
                role: 'assistant',
                content: [],
                model: openAIChunk.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: openAIChunk.usage?.prompt_tokens || 0,
                    output_tokens: 0
                }
            }
        });
        state.messageStartSent = true;
    }

    // 处理文本内容
    if (delta.content) {
        // 如果有工具块打开，先关闭它
        if (state.contentBlockOpen && state.currentBlockType === 'tool_use') {
            events.push({
                type: 'content_block_stop',
                index: state.contentBlockIndex
            });
            state.contentBlockIndex++;
            state.contentBlockOpen = false;
        }

        // 打开文本块
        if (!state.contentBlockOpen) {
            events.push({
                type: 'content_block_start',
                index: state.contentBlockIndex,
                content_block: {
                    type: 'text',
                    text: ''
                }
            });
            state.contentBlockOpen = true;
            state.currentBlockType = 'text';
        }

        // 发送文本增量
        events.push({
            type: 'content_block_delta',
            index: state.contentBlockIndex,
            delta: {
                type: 'text_delta',
                text: delta.content
            }
        });
    }

    // 处理 tool_calls
    if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
            const tcIndex = toolCall.index;
            
            if (!state.toolCalls[tcIndex]) {
                // 新的 tool call
                if (state.contentBlockOpen) {
                    events.push({
                        type: 'content_block_stop',
                        index: state.contentBlockIndex
                    });
                    state.contentBlockIndex++;
                    state.contentBlockOpen = false;
                }

                state.toolCalls[tcIndex] = {
                    id: toolCall.id || '',
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '',
                    blockIndex: state.contentBlockIndex
                };

                events.push({
                    type: 'content_block_start',
                    index: state.contentBlockIndex,
                    content_block: {
                        type: 'tool_use',
                        id: toolCall.id || '',
                        name: toolCall.function?.name || '',
                        input: {}
                    }
                });
                state.contentBlockOpen = true;
                state.currentBlockType = 'tool_use';
            } else {
                // 追加参数
                if (toolCall.function?.arguments) {
                    state.toolCalls[tcIndex].arguments += toolCall.function.arguments;
                    
                    events.push({
                        type: 'content_block_delta',
                        index: state.toolCalls[tcIndex].blockIndex,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: toolCall.function.arguments
                        }
                    });
                }
            }
        }
    }

    // 处理完成
    if (choice.finish_reason) {
        if (state.contentBlockOpen) {
            events.push({
                type: 'content_block_stop',
                index: state.contentBlockIndex
            });
            state.contentBlockOpen = false;
        }

        events.push({
            type: 'message_delta',
            delta: {
                stop_reason: mapStopReason(choice.finish_reason),
                stop_sequence: null
            },
            usage: {
                output_tokens: openAIChunk.usage?.completion_tokens || 0
            }
        });

        events.push({
            type: 'message_stop'
        });
    }

    return events;
}

export {sharedOpenAIToAnthropic as openAIToAnthropic};
