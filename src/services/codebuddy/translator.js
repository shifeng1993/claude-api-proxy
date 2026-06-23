/**
 * CodeBuddy Anthropic 到 OpenAI 格式转换模块
 * 复用 OpenAI 兼容接口的流式处理逻辑
 * @module services/codebuddy/translator
 */

import logger from '../../utils/logger.js';
import {cleanJsonSchema} from '../../utils/helpers.js';
import {
    translateToolChoice,
    mapContent,
    injectBehaviorRules,
    prependThinkingHint,
    prependToolThinkingHint,
    openAIToAnthropic as sharedOpenAIToAnthropic,
    normalizeClaudeModelAlias,
    sortObjectKeys
} from '../../transformer/shared-translator.js';

/**
 * 转换 Anthropic 请求到 OpenAI 格式
 */
export function anthropicToOpenAI(anthropicPayload) {
    const openAIPayload = {
        model: normalizeClaudeModelAlias(anthropicPayload.model),
        messages: translateMessages(anthropicPayload.messages, anthropicPayload.system),
        max_tokens: anthropicPayload.max_tokens,
        temperature: anthropicPayload.temperature,
        top_p: anthropicPayload.top_p,
        stream: anthropicPayload.stream,
        stop: anthropicPayload.stop_sequences
    };

    // 转换 tools
    if (anthropicPayload.tools) {
        openAIPayload.tools = anthropicPayload.tools.map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: cleanJsonSchema(tool.input_schema)
            }
        }));
    }

    // 转换 tool_choice
    if (anthropicPayload.tool_choice) {
        openAIPayload.tool_choice = translateToolChoice(anthropicPayload.tool_choice);
    }

    // reasoning_effort 统一由 resolveThinkingConfig + normalizePayload 处理
    const thinkingConfig = resolveThinkingConfig(anthropicPayload);
    if (thinkingConfig.disabled) {
        // 显式设空字符串，normalizePayload 识别后删除字段、不补默认值
        openAIPayload.reasoning_effort = '';
    } else if (thinkingConfig.effort) {
        openAIPayload.reasoning_effort = thinkingConfig.effort;
    }

    return openAIPayload;
}

/**
 * 从 Anthropic 请求中解析 thinking 配置
 * 返回 { disabled: boolean, effort: string|null }
 *
 * 优先级：output_config.effort > thinking 配置推断 > 默认 high
 */
function resolveThinkingConfig(anthropicPayload) {
    const thinking = anthropicPayload.thinking;

    // thinking.type === 'disabled' 明确关闭思考
    if (thinking?.type === 'disabled') {
        return {disabled: true, effort: ''};
    }

    let effort = null;

    // 1. 优先从 output_config.effort 读取（Claude Code 新版传递方式）
    const outputEffort = anthropicPayload.output_config?.effort;
    if (outputEffort && typeof outputEffort === 'string') {
        const effortMap = {low: 'low', medium: 'medium', high: 'high', max: 'high'};
        const mapped = effortMap[outputEffort.toLowerCase()];
        if (mapped) {
            effort = mapped;
        }
    }

    // 2. 根据 thinking 配置推断
    if (!effort && thinking) {
        if (thinking.type === 'adaptive') {
            effort = 'high';
        } else if (thinking.type === 'enabled' && thinking.budget_tokens) {
            if (thinking.budget_tokens <= 4000) effort = 'low';
            else if (thinking.budget_tokens <= 16000) effort = 'medium';
            else effort = 'high';
        }
    }

    return {disabled: false, effort};
}

/**
 * 转换消息列表
 */
function translateMessages(anthropicMessages, system) {
    const messages = [];

    // 处理 system message（不注入行为规则，最后统一注入）
    if (system) {
        if (typeof system === 'string') {
            messages.push({role: 'system', content: system});
        } else if (Array.isArray(system)) {
            const systemText = system.map((block) => block.text.trim()).join('\n\n');
            if (systemText) {
                messages.push({role: 'system', content: systemText});
            }
        }
    }

    // 处理其他消息
    let lastAssistantMessage = null;
    for (const message of anthropicMessages) {
        if (message.role === 'user') {
            // 传递前一条 assistant 消息，用于按 tool_calls 顺序排列 tool_result
            const userMessages = handleUserMessage(message, lastAssistantMessage);
            messages.push(...userMessages);
            // 处理完 user 消息后，清除 lastAssistantMessage
            // 因为 tool_result 已经处理完毕
            lastAssistantMessage = null;
        } else {
            const assistantMessages = handleAssistantMessage(message);
            messages.push(...assistantMessages);
            // 保存 assistant 消息的 tool_calls 信息，用于下一轮 user 消息的 tool_result 排序
            if (assistantMessages.length > 0 && assistantMessages[0].tool_calls) {
                lastAssistantMessage = assistantMessages[0];
            } else {
                lastAssistantMessage = null;
            }
        }
    }

    return messages;
}

/**
 * 处理用户消息
 */
function handleUserMessage(message, previousAssistantMessage = null) {
    const messages = [];

    if (typeof message.content === 'string') {
        messages.push({role: 'user', content: prependThinkingHint(message.content)});
    } else if (Array.isArray(message.content)) {
        // 分离 tool_result 和其他内容
        const toolResults = message.content.filter((block) => block.type === 'tool_result');
        const otherBlocks = message.content.filter((block) => block.type !== 'tool_result');

        // tool_result 必须先处理
        if (toolResults.length > 0) {
            // 创建 tool_use_id 到 tool_result 的映射
            const resultMap = new Map();
            for (const block of toolResults) {
                let content = '';
                if (typeof block.content === 'string') {
                    content = block.content;
                } else if (block.content != null) {
                    content = JSON.stringify(block.content);
                }
                resultMap.set(block.tool_use_id, prependToolThinkingHint(content));
            }

            // 如果有前一条 assistant 消息，按照 tool_calls 的顺序排列 tool_result
            // 这样可以保证 tool 消息的顺序与 assistant 中的 tool_calls 顺序一致
            if (previousAssistantMessage && previousAssistantMessage.tool_calls) {
                const orderedIds = previousAssistantMessage.tool_calls.map((tc) => tc.id);

                for (const toolId of orderedIds) {
                    if (resultMap.has(toolId)) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolId,
                            content: resultMap.get(toolId)
                        });
                        resultMap.delete(toolId);
                    }
                }
            }

            // 添加剩余的 tool_result（如果有）
            for (const [toolId, content] of resultMap) {
                messages.push({
                    role: 'tool',
                    tool_call_id: toolId,
                    content
                });
            }
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
        return [{role: 'assistant', content: message.content}];
    }

    if (!Array.isArray(message.content)) {
        return [{role: 'assistant', content: null}];
    }

    // 提取不同类型的块
    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
    const textBlocks = message.content.filter((block) => block.type === 'text');
    const thinkingBlocks = message.content.filter((block) => block.type === 'thinking');

    // 只合并文本内容，不包含 thinking 内容
    const allText = textBlocks
        .map((b) => b.text)
        .filter(Boolean)
        .join('\n\n');

    const result = {
        role: 'assistant',
        content: allText || (toolUseBlocks.length > 0 ? '' : null)
    };

    // fix: 将 thinking 转换为 reasoning_content（DeepSeek 和 kimi 要求多轮回传）
    const reasoningText = thinkingBlocks
        .map((b) => b.thinking)
        .filter(Boolean)
        .join('\n\n');
    if (reasoningText) {
        result.reasoning_content = reasoningText;
    }

    // 添加 tool_calls
    if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map((block) => {
            // 确保 input 是有效的对象，避免 JSON.stringify 返回 "null" 或 "undefined"
            let args = '{}';
            if (block.input !== undefined && block.input !== null) {
                try {
                    args = JSON.stringify(sortObjectKeys(block.input));
                } catch (e) {
                    logger.warn(`Failed to stringify tool input for ${block.name}:`, e.message);
                    args = '{}';
                }
            }
            return {
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: args
                }
            };
        });
    }

    return [result];
}

/**
 * 转换工具调用 ID (tooluse_xxx -> call_xxx)
 * CodeBuddy 使用 tooluse_xxx 格式，需要转换为 call_xxx 格式以兼容 OpenAI
 */
export function convertToolCallId(codebuddyId) {
    if (codebuddyId && codebuddyId.startsWith('tooluse_')) {
        return `call_${codebuddyId.slice(8)}`;
    }
    return codebuddyId;
}

export {sharedOpenAIToAnthropic as openAIToAnthropic};
export {rewriteOpenAIStream} from '../../transformer/shared-translator.js';
