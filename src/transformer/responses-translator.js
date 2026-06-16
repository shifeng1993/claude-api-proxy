/**
 * OpenAI Responses API 格式转换模块
 * 实现 Responses ↔ Chat Completions 双向转换
 * @module transformer/responses-translator
 */

import logger from '../utils/logger.js';
import {generateId} from './shared-translator.js';

/* ================= Responses Request → Chat Completions Request ================= */

/**
 * 将 Responses API 请求转换为 Chat Completions 请求
 * @param {Object} responsesReq - Responses API 请求体
 * @returns {Object} Chat Completions 请求体
 */
export function responsesRequestToChat(responsesReq) {
    const messages = [];

    // instructions → system message
    if (responsesReq.instructions) {
        messages.push({role: 'system', content: responsesReq.instructions});
    }

    // input → messages
    if (typeof responsesReq.input === 'string') {
        messages.push({role: 'user', content: responsesReq.input});
    } else if (Array.isArray(responsesReq.input)) {
        for (const item of responsesReq.input) {
            const converted = convertInputItem(item);
            if (converted) messages.push(...(Array.isArray(converted) ? converted : [converted]));
        }
    }

    // 合并连续同角色消息（主要处理 reasoning → assistant 的合并）
    // reasoning item 被转为 {role:'assistant', reasoning_content:'...'}，
    // 后续的 assistant 消息需要与之合并为一条，否则 Chat API 不允许连续 assistant 消息
    _mergeConsecutiveMessages(messages);

    const chatReq = {
        model: responsesReq.model,
        messages,
        stream: responsesReq.stream,
        temperature: responsesReq.temperature,
        top_p: responsesReq.top_p
    };

    // max_output_tokens → max_tokens
    if (responsesReq.max_output_tokens) {
        chatReq.max_tokens = responsesReq.max_output_tokens;
    }

    // reasoning → reasoning_effort
    if (responsesReq.reasoning?.effort) {
        chatReq.reasoning_effort = responsesReq.reasoning.effort;
    }

    // tools: Responses 扁平格式 → Chat 嵌套格式
    // 仅保留 function 类型，其他类型（web_search、code_interpreter 等）
    // 非 OpenAI 原生 Chat Completions 接口不支持，透传会导致上游 400
    if (Array.isArray(responsesReq.tools) && responsesReq.tools.length > 0) {
        const functionTools = responsesReq.tools
            .filter((tool) => tool.type === 'function')
            .map((tool) => responsesFunctionToolToChat(tool));
        if (functionTools.length > 0) {
            chatReq.tools = functionTools;
        }
    }

    // tool_choice / parallel_tool_calls 仅在有 function tools 时发送
    if (chatReq.tools) {
        if (responsesReq.tool_choice) {
            chatReq.tool_choice = convertToolChoice(responsesReq.tool_choice);
        }
        if (responsesReq.parallel_tool_calls !== undefined) {
            chatReq.parallel_tool_calls = responsesReq.parallel_tool_calls;
        }
    }

    // previous_response_id 保留在扩展字段中（不影响 Chat Completions）
    if (responsesReq.previous_response_id) {
        chatReq.previous_response_id = responsesReq.previous_response_id;
    }

    // store
    if (responsesReq.store !== undefined) {
        chatReq.store = responsesReq.store;
    }

    // text.format → response_format
    // 火山引擎等上游不支持 response_format（json_schema/json_object 均会 400），直接移除
    // 如果上游支持 response_format，可按需调整此处
    if (responsesReq.text?.format) {
        // 不设置 chatReq.response_format，火山引擎等上游不支持
    }

    return chatReq;
}

export function chatRequestToResponses(chatReq) {
    const input = [];
    const instructions = [];

    for (const message of chatReq.messages || []) {
        if (!message || typeof message !== 'object') continue;

        if (message.role === 'system') {
            const systemText = extractTextContent(message.content);
            if (systemText) instructions.push(systemText);
            continue;
        }

        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id || '',
                output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')
            });
            continue;
        }

        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            // reasoning_content → reasoning item（在 function_call 之前）
            if (message.reasoning_content) {
                input.push({
                    type: 'reasoning',
                    summary: [{type: 'summary_text', text: message.reasoning_content}]
                });
            }
            if (message.content) {
                input.push({
                    role: 'assistant',
                    content: convertChatMessageContentToResponses(message.content, 'output_text')
                });
            }

            for (const toolCall of message.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id || `call_${generateId()}`,
                    name: toolCall.function?.name || '',
                    arguments: toolCall.function?.arguments || '{}'
                });
            }
            continue;
        }

        // assistant 消息（无 tool_calls）—— 处理 reasoning_content
        if (message.role === 'assistant') {
            // reasoning_content → reasoning item（在 message 之前）
            if (message.reasoning_content) {
                input.push({
                    type: 'reasoning',
                    summary: [{type: 'summary_text', text: message.reasoning_content}]
                });
            }
            input.push({
                role: 'assistant',
                content: convertChatMessageContentToResponses(message.content, 'output_text')
            });
            continue;
        }

        input.push({
            role: message.role,
            content: convertChatMessageContentToResponses(message.content, message.role === 'assistant' ? 'output_text' : 'input_text')
        });
    }

    const responsesReq = {
        model: chatReq.model,
        input,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };

    if (instructions.length > 0) {
        responsesReq.instructions = instructions.join('\n\n');
    }

    if (chatReq.max_tokens !== undefined) {
        responsesReq.max_output_tokens = chatReq.max_tokens;
    }

    if (chatReq.reasoning_effort) {
        responsesReq.reasoning = {effort: chatReq.reasoning_effort};
    }

    if (Array.isArray(chatReq.tools) && chatReq.tools.length > 0) {
        responsesReq.tools = chatReq.tools.map((tool) => {
            if (tool.type === 'function') {
                return chatFunctionToolToResponses(tool);
            }
            return tool;
        });
    }

    if (chatReq.tool_choice) {
        responsesReq.tool_choice = convertChatToolChoice(chatReq.tool_choice);
    }

    if (chatReq.parallel_tool_calls !== undefined) {
        responsesReq.parallel_tool_calls = chatReq.parallel_tool_calls;
    }

    if (chatReq.previous_response_id) {
        responsesReq.previous_response_id = chatReq.previous_response_id;
    }

    if (chatReq.store !== undefined) {
        responsesReq.store = chatReq.store;
    }

    if (chatReq.response_format) {
        responsesReq.text = {format: chatReq.response_format};
    }

    return responsesReq;
}

/**
 * 合并连续同角色消息
 * Responses API 中 reasoning 和 assistant message 是独立的 input item，
 * 转换为 Chat Completions 后可能产生连续的 assistant 消息，需要合并
 * 规则：后一条消息的内容（content/reasoning_content/tool_calls）合并到前一条
 */
function _mergeConsecutiveMessages(messages) {
    let i = 0;
    while (i < messages.length - 1) {
        const curr = messages[i];
        const next = messages[i + 1];
        if (curr.role === next.role) {
            // 合并 reasoning_content
            if (next.reasoning_content && !curr.reasoning_content) {
                curr.reasoning_content = next.reasoning_content;
            } else if (next.reasoning_content && curr.reasoning_content) {
                curr.reasoning_content += '\n\n' + next.reasoning_content;
            }
            // 合并 content
            if (next.content != null && curr.content == null) {
                curr.content = next.content;
            } else if (next.content != null && curr.content != null) {
                const currText = typeof curr.content === 'string' ? curr.content : JSON.stringify(curr.content);
                const nextText = typeof next.content === 'string' ? next.content : JSON.stringify(next.content);
                if (nextText) curr.content = currText ? currText + '\n\n' + nextText : nextText;
            }
            // 合并 tool_calls
            if (next.tool_calls) {
                curr.tool_calls = [...(curr.tool_calls || []), ...next.tool_calls];
            }
            messages.splice(i + 1, 1);
            // 不递增 i，继续检查合并后的消息是否还需要和下一项合并
        } else {
            i++;
        }
    }
}

/**
 * 转换单个 input 项为 Chat Completions 消息
 */
function convertInputItem(item) {
    if (!item || typeof item !== 'object') return null;

    // {role: "user/assistant/developer", content: ...} — 消息格式
    // developer (OpenAI Responses API 系统指令角色) → system (Chat Completions)
    if (item.role) {
        const mappedRole = item.role === 'developer' ? 'system' : item.role;
        if (typeof item.content === 'string') {
            return {role: mappedRole, content: item.content};
        }
        if (Array.isArray(item.content)) {
            // 转换 content parts
            const parts = item.content.map(convertContentPart).filter(Boolean);
            if (parts.length === 1 && parts[0].type === 'text') {
                return {role: mappedRole, content: parts[0].text};
            }
            return {role: mappedRole, content: parts};
        }
        return {role: mappedRole, content: item.content || ''};
    }

    // {type: "function_call", ...} — 工具调用
    if (item.type === 'function_call') {
        return {
            role: 'assistant',
            tool_calls: [{
                id: item.call_id || generateId(),
                type: 'function',
                function: {
                    name: item.name,
                    arguments: item.arguments || '{}'
                }
            }]
        };
    }

    // {type: "function_call_output", ...} — 工具输出
    if (item.type === 'function_call_output') {
        return {
            role: 'tool',
            tool_call_id: item.call_id || '',
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '')
        };
    }

    // {type: "input_text", ...} — 文本输入
    if (item.type === 'input_text') {
        return {role: 'user', content: item.text || ''};
    }

    // {type: "output_text", ...} — 文本输出
    if (item.type === 'output_text') {
        return {role: 'assistant', content: item.text || ''};
    }

    // 其他类型尝试作为 user 消息
    if (item.text) {
        return {role: 'user', content: item.text};
    }

    return null;
}

/**
 * 转换 content part
 */
function convertContentPart(part) {
    if (!part || typeof part !== 'object') return null;

    switch (part.type) {
        case 'input_text':
            return {type: 'text', text: part.text || ''};
        case 'output_text':
            return {type: 'text', text: part.text || ''};
        case 'input_image':
            return {type: 'image_url', image_url: {url: part.image_url || part.url || ''}};
        case 'input_file':
            return {type: 'file', file: part.file || part.file_url || ''};
        default:
            if (part.text) return {type: 'text', text: part.text};
            return null;
    }
}

/**
 * 转换 tool_choice: Responses 扁平格式 → Chat 嵌套格式
 */
function convertToolChoice(choice) {
    if (typeof choice === 'string') return choice;
    if (!choice || typeof choice !== 'object') return choice;

    // {type: "function", name: "xxx"} → {type: "function", function: {name: "xxx"}}
    if (choice.type === 'function' && choice.name) {
        return {type: 'function', function: {name: choice.name}};
    }

    return choice;
}

function convertChatToolChoice(choice) {
    if (typeof choice === 'string') return choice;
    if (!choice || typeof choice !== 'object') return choice;
    if (choice.type === 'function' && choice.function?.name) {
        return {type: 'function', name: choice.function.name};
    }
    return choice;
}

function responsesFunctionToolToChat(tool) {
    const {
        type,
        name,
        description = '',
        parameters = {},
        ...rest
    } = tool;

    return {
        type: 'function',
        function: {
            name: name || '',
            description,
            parameters,
            ...rest
        }
    };
}

function chatFunctionToolToResponses(tool) {
    const {
        name = '',
        description = '',
        parameters = {},
        ...rest
    } = tool.function || {};

    return {
        type: 'function',
        name,
        description,
        parameters,
        ...rest
    };
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            return '';
        })
        .filter(Boolean)
        .join('\n');
}

function convertChatMessageContentToResponses(content, textType = 'input_text') {
    if (typeof content === 'string') {
        return [{type: textType, text: content}];
    }

    if (!Array.isArray(content)) {
        return [{type: textType, text: content ? JSON.stringify(content) : ''}];
    }

    return content
        .map((part) => {
            if (!part || typeof part !== 'object') return null;
            if (part.type === 'text') {
                return {type: textType, text: part.text || ''};
            }
            if (part.type === 'image_url') {
                return {type: 'input_image', image_url: part.image_url?.url || part.image_url || ''};
            }
            if (part.type === 'input_text' || part.type === 'output_text') {
                return {type: textType, text: part.text || ''};
            }
            if (part.type === 'input_image') {
                return part;
            }
            return part.text ? {type: textType, text: part.text} : null;
        })
        .filter(Boolean);
}

/* ================= Chat Completions Response → Responses Response ================= */

/**
 * 将 Chat Completions 非流式响应转换为 Responses 非流式响应
 * @param {Object} chatRes - Chat Completions 响应
 * @returns {Object} Responses API 响应
 */
export function chatResponseToResponses(chatRes) {
    const choice = chatRes.choices?.[0];
    const message = choice?.message;

    const output = [];
    const responseId = `resp_${generateId()}`;

    // 提取文本和工具调用
    if (message) {
        // reasoning_content → reasoning 输出项
        const reasoningContent = message.reasoning_content || message.reasoning;
        if (reasoningContent) {
            const reasoningText = typeof reasoningContent === 'string'
                ? reasoningContent
                : reasoningContent.content || '';
            if (reasoningText) {
                output.push({
                    type: 'reasoning',
                    id: `rs_${generateId()}`,
                    summary: [{type: 'summary_text', text: reasoningText}]
                });
            }
        }

        // 文本内容 → message 输出项
        if (message.content) {
            output.push({
                type: 'message',
                id: `msg_${generateId()}`,
                status: 'completed',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text: message.content,
                    annotations: []
                }]
            });
        }

        // tool_calls → function_call 输出项
        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const tc of message.tool_calls) {
                output.push({
                    type: 'function_call',
                    id: `fc_${generateId()}`,
                    call_id: tc.id || `call_${generateId()}`,
                    name: tc.function?.name || '',
                    status: 'completed',
                    arguments: tc.function?.arguments || '{}'
                });
            }
        }
    }

    // 确定状态
    const hasToolCalls = output.some((o) => o.type === 'function_call');
    const status = chatRes.error ? 'failed' : (choice?.finish_reason === 'length' ? 'incomplete' : 'completed');

    return {
        id: responseId,
        object: 'response',
        created_at: chatRes.created || Math.floor(Date.now() / 1000),
        status,
        error: chatRes.error || null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: chatRes.model || 'unknown',
        output,
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: null,
        store: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
        truncation: null,
        usage: convertUsage(chatRes.usage),
        user: null,
        metadata: {}
    };
}

export function responsesResponseToChat(responsesRes) {
    const textParts = [];
    const toolCalls = [];
    const reasoningParts = [];

    for (const item of responsesRes.output || []) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const contentPart of item.content) {
                if (contentPart?.type === 'output_text' && contentPart.text) {
                    textParts.push(contentPart.text);
                }
            }
        }

        if (item.type === 'function_call') {
            toolCalls.push({
                id: item.call_id || item.id || `call_${generateId()}`,
                type: 'function',
                function: {
                    name: item.name || '',
                    arguments: item.arguments || '{}'
                }
            });
        }

        if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            for (const summaryPart of item.summary) {
                if (summaryPart?.text) reasoningParts.push(summaryPart.text);
            }
        }
    }

    return {
        id: responsesRes.id || `chatcmpl_${generateId()}`,
        object: 'chat.completion',
        created: responsesRes.created_at || Math.floor(Date.now() / 1000),
        model: responsesRes.model || 'unknown',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: textParts.join('') || null,
                reasoning_content: reasoningParts.join('\n') || undefined,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined
            },
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : responsesRes.status === 'incomplete' ? 'length' : 'stop'
        }],
        usage: convertResponsesUsageToChat(responsesRes.usage)
    };
}

export function convertResponsesUsageToChat(usage) {
    if (!usage) return {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};
    return {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens || 0
        },
        completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0
        }
    };
}

/**
 * 转换 usage 格式
 */
function convertUsage(usage) {
    if (!usage) return {input_tokens: 0, output_tokens: 0, total_tokens: 0};
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
        },
        output_tokens_details: {
            reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0
        }
    };
}

/* ================= 流式转换: Chat Completions SSE → Responses SSE ================= */

/**
 * 创建流式转换状态
 */
export function createResponsesStreamState() {
    return {
        responseId: `resp_${generateId()}`,
        started: false,
        finished: false,
        outputIndex: 0,
        contentIndex: 0,
        currentMessageId: null,
        messageOpen: false,
        // tool call 追踪
        toolCallIndexByCallId: new Map(),
        toolCallItemIds: new Map(),
        toolCallNames: new Map(),
        toolCallArgs: new Map(),
        nextToolCallIndex: 0,
        // reasoning
        reasoningOpen: false,
        reasoningItemId: null,
        reasoningText: '',
        // text 累积
        textBuffer: '',
        output: []
    };
}

export function createChatCompletionsStreamState() {
    return {
        chatId: `chatcmpl_${generateId()}`,
        created: Math.floor(Date.now() / 1000),
        model: 'unknown',
        roleSent: false,
        toolCalls: new Map(),
        nextToolIndex: 0,
        sawToolCall: false,
        completed: false,
        // reasoning
        reasoningOpen: false
    };
}

export function responsesEventToResponsesEvents(eventName, eventData, chatState, responsesState) {
    const chatChunks = responsesEventToChatChunks(eventName, eventData, chatState);
    const events = [];
    for (const chunk of chatChunks) {
        events.push(...chatChunkToResponsesEvents(chunk, responsesState));
    }
    return events;
}

export function responsesEventToChatChunks(eventName, eventData, state) {
    const chunks = [];

    const buildChunk = (delta, finishReason = null, usage) => ({
        id: state.chatId,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{
            index: 0,
            delta,
            finish_reason: finishReason
        }],
        ...(usage ? {usage} : {})
    });

    const ensureAssistantRole = () => {
        if (!state.roleSent) {
            chunks.push(buildChunk({role: 'assistant'}));
            state.roleSent = true;
        }
    };

    const ensureToolCallStart = (toolCall) => {
        ensureAssistantRole();
        if (toolCall.emitted) return;

        chunks.push(buildChunk({
            tool_calls: [{
                index: toolCall.index,
                id: toolCall.id,
                type: 'function',
                function: {
                    name: toolCall.name,
                    arguments: ''
                }
            }]
        }));
        toolCall.emitted = true;
    };

    const emitToolCallArguments = (toolCall, argsText) => {
        if (!argsText) return;
        ensureToolCallStart(toolCall);

        chunks.push(buildChunk({
            tool_calls: [{
                index: toolCall.index,
                function: {
                    arguments: argsText
                }
            }]
        }));
        toolCall.emittedArgs += argsText;
    };

    const flushPendingToolCallArguments = () => {
        for (const toolCall of state.toolCalls.values()) {
            const pendingArgs = toolCall.finalArgs || '';
            if (!pendingArgs) continue;

            if (pendingArgs.startsWith(toolCall.emittedArgs)) {
                emitToolCallArguments(toolCall, pendingArgs.slice(toolCall.emittedArgs.length));
            } else if (!toolCall.emittedArgs) {
                emitToolCallArguments(toolCall, pendingArgs);
            }
        }
    };

    const ensureCompletedToolCalls = () => {
        for (const item of eventData.response?.output || []) {
            if (item?.type !== 'function_call') continue;
            const itemId = item.id || item.call_id || `fc_${generateId()}`;
            if (!state.toolCalls.has(itemId)) {
                state.sawToolCall = true;
                state.toolCalls.set(itemId, {
                    index: state.nextToolIndex++,
                    id: item.call_id || item.id || `call_${generateId()}`,
                    name: item.name || '',
                    emitted: false,
                    emittedArgs: '',
                    finalArgs: typeof item.arguments === 'string' ? item.arguments : ''
                });
                continue;
            }

            const toolCall = state.toolCalls.get(itemId);
            if (item.call_id) toolCall.id = item.call_id;
            if (item.name) toolCall.name = item.name;
            if (typeof item.arguments === 'string') toolCall.finalArgs = item.arguments;
        }
    };

    if (eventName === 'response.created') {
        state.model = eventData.response?.model || state.model;
        return chunks;
    }

    if (eventName === 'response.output_item.added' && eventData.item?.type === 'reasoning') {
        state.reasoningOpen = true;
        return chunks;
    }

    if (eventName === 'response.output_item.added' && eventData.item?.type === 'function_call') {
        const item = eventData.item;
        const toolIndex = state.nextToolIndex++;
        state.sawToolCall = true;
        state.toolCalls.set(item.id, {
            index: toolIndex,
            id: item.call_id || item.id || `call_${generateId()}`,
            name: item.name || '',
            emitted: false,
            emittedArgs: '',
            finalArgs: typeof item.arguments === 'string' ? item.arguments : ''
        });
        return chunks;
    }

    if (eventName === 'response.reasoning_summary_text.delta') {
        ensureAssistantRole();
        chunks.push(buildChunk({reasoning_content: eventData.delta || ''}));
        return chunks;
    }

    if (eventName === 'response.reasoning_summary_part.added') {
        return chunks;
    }

    if (eventName === 'response.reasoning_summary_part.done') {
        return chunks;
    }

    if (eventName === 'response.output_item.done' && eventData.item?.type === 'reasoning') {
        state.reasoningOpen = false;
        return chunks;
    }

    if (eventName === 'response.output_text.delta') {
        ensureAssistantRole();
        chunks.push(buildChunk({content: eventData.delta || ''}));
        return chunks;
    }

    if (eventName === 'response.function_call_arguments.delta') {
        const toolCall = state.toolCalls.get(eventData.item_id);
        if (!toolCall) return chunks;

        toolCall.finalArgs += eventData.delta || '';
        emitToolCallArguments(toolCall, eventData.delta || '');
        return chunks;
    }

    if (eventName === 'response.function_call_arguments.done') {
        const toolCall = state.toolCalls.get(eventData.item_id);
        if (!toolCall) return chunks;

        if (typeof eventData.arguments === 'string') {
            toolCall.finalArgs = eventData.arguments;
        }

        flushPendingToolCallArguments();
        return chunks;
    }

    if (eventName === 'response.completed') {
        state.model = eventData.response?.model || state.model;
        state.completed = true;
        ensureCompletedToolCalls();
        flushPendingToolCallArguments();
        chunks.push(
            buildChunk(
                {},
                state.sawToolCall ? 'tool_calls' : 'stop',
                convertResponsesUsageToChat(eventData.response?.usage)
            )
        );
    }

    return chunks;
}

/**
 * 将 Chat Completions 流式 chunk 转换为 Responses API SSE 事件
 * @param {Object} data - 解析后的 Chat Completions chunk
 * @param {Object} state - 流状态
 * @returns {Array<{event: string, data: Object}>} Responses SSE 事件列表
 */
export function chatChunkToResponsesEvents(data, state) {
    const events = [];

    // 发送 response.created（仅首次）
    if (!state.started) {
        state.started = true;
        events.push({
            event: 'response.created',
            data: {
                type: 'response.created',
                response: {
                    id: state.responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'in_progress',
                    model: data.model || 'unknown',
                    output: [],
                    parallel_tool_calls: true
                }
            }
        });
    }

    const choice = data.choices?.[0];
    if (!choice) return events;
    const delta = choice.delta;

    const addCompletedOutput = (item) => {
        if (!item) return;
        state.output.push(item);
    };

    // reasoning_content → reasoning 输出项 + summary 事件
    if (delta?.reasoning_content) {
        if (!state.reasoningOpen) {
            state.reasoningOpen = true;
            state.reasoningItemId = `rs_${generateId()}`;
            state.reasoningText = '';

            // 发送 reasoning 输出项 added
            events.push({
                event: 'response.output_item.added',
                data: {
                    type: 'response.output_item.added',
                    output_index: state.outputIndex,
                    item: {
                        type: 'reasoning',
                        id: state.reasoningItemId
                    }
                }
            });

            // 发送 reasoning_summary_part.added
            events.push({
                event: 'response.reasoning_summary_part.added',
                data: {
                    type: 'response.reasoning_summary_part.added',
                    output_index: state.outputIndex,
                    summary_index: 0,
                    item_id: state.reasoningItemId,
                    part: {type: 'summary_text', text: ''}
                }
            });
        }

        state.reasoningText += delta.reasoning_content;

        events.push({
            event: 'response.reasoning_summary_text.delta',
            data: {
                type: 'response.reasoning_summary_text.delta',
                delta: delta.reasoning_content,
                output_index: state.outputIndex,
                summary_index: 0,
                item_id: state.reasoningItemId
            }
        });
    }

    // reasoning 结束：收到 signature 或开始输出 content
    if (delta?.reasoning_signature || (state.reasoningOpen && delta?.content)) {
        if (state.reasoningOpen) {
            // 发送 reasoning_summary_part.done
            events.push({
                event: 'response.reasoning_summary_part.done',
                data: {
                    type: 'response.reasoning_summary_part.done',
                    output_index: state.outputIndex,
                    summary_index: 0,
                    item_id: state.reasoningItemId,
                    part: {type: 'summary_text', text: state.reasoningText}
                }
            });

            const item = {
                type: 'reasoning',
                id: state.reasoningItemId,
                status: 'completed',
                summary: [{type: 'summary_text', text: state.reasoningText}]
            };
            events.push({
                event: 'response.output_item.done',
                data: {
                    type: 'response.output_item.done',
                    output_index: state.outputIndex,
                    item
                }
            });
            addCompletedOutput(item);

            state.outputIndex++;
            state.reasoningOpen = false;
            state.reasoningItemId = null;
            state.reasoningText = '';
        }
    }

    // content → output_text.delta
    if (delta?.content && !delta.reasoning_content) {
        // 如果没有打开 message 输出项，先创建
        if (!state.messageOpen) {
            state.currentMessageId = `msg_${generateId()}`;
            state.messageOpen = true;
            state.contentIndex = 0;
            state.textBuffer = '';

            events.push({
                event: 'response.output_item.added',
                data: {
                    type: 'response.output_item.added',
                    output_index: state.outputIndex,
                    item: {
                        type: 'message',
                        id: state.currentMessageId,
                        status: 'in_progress',
                        role: 'assistant',
                        content: []
                    }
                }
            });
            events.push({
                event: 'response.content_part.added',
                data: {
                    type: 'response.content_part.added',
                    output_index: state.outputIndex,
                    content_index: 0,
                    part: {type: 'output_text', text: '', annotations: []}
                }
            });
        }

        state.textBuffer += delta.content;

        events.push({
            event: 'response.output_text.delta',
            data: {
                type: 'response.output_text.delta',
                item_id: state.currentMessageId,
                delta: delta.content,
                output_index: state.outputIndex,
                content_index: 0
            }
        });
    }

    // tool_calls
    if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
            const callId = tc.id;
            const tcIndex = tc.index;

            // 新 tool call 开始
            if (tc.function?.name) {
                const itemId = `fc_${generateId()}`;

                // 如果有打开的 message，先关闭
                if (state.messageOpen) {
                    events.push({
                        event: 'response.content_part.done',
                        data: {
                            type: 'response.content_part.done',
                            output_index: state.outputIndex,
                            content_index: 0,
                            part: {type: 'output_text', text: state.textBuffer, annotations: []}
                        }
                    });
                    const item = {
                        type: 'message',
                        id: state.currentMessageId,
                        status: 'completed',
                        role: 'assistant',
                        content: [{type: 'output_text', text: state.textBuffer, annotations: []}]
                    };
                    events.push({
                        event: 'response.output_item.done',
                        data: {
                            type: 'response.output_item.done',
                            output_index: state.outputIndex,
                            item
                        }
                    });
                    addCompletedOutput(item);
                    state.outputIndex++;
                    state.messageOpen = false;
                    state.textBuffer = '';
                }

                // 如果 reasoning 还开着，先关
                if (state.reasoningOpen) {
                    events.push({
                        event: 'response.reasoning_summary_part.done',
                        data: {
                            type: 'response.reasoning_summary_part.done',
                            output_index: state.outputIndex,
                            summary_index: 0,
                            item_id: state.reasoningItemId,
                            part: {type: 'summary_text', text: state.reasoningText}
                        }
                    });
                    const item = {
                        type: 'reasoning',
                        id: state.reasoningItemId,
                        status: 'completed',
                        summary: [{type: 'summary_text', text: state.reasoningText}]
                    };
                    events.push({
                        event: 'response.output_item.done',
                        data: {
                            type: 'response.output_item.done',
                            output_index: state.outputIndex,
                            item
                        }
                    });
                    addCompletedOutput(item);
                    state.outputIndex++;
                    state.reasoningOpen = false;
                    state.reasoningItemId = null;
                    state.reasoningText = '';
                }

                state.toolCallIndexByCallId.set(callId, tcIndex);
                state.toolCallItemIds.set(tcIndex, itemId);
                state.toolCallNames.set(tcIndex, tc.function.name);
                state.toolCallArgs.set(tcIndex, '');

                events.push({
                    event: 'response.output_item.added',
                    data: {
                        type: 'response.output_item.added',
                        output_index: state.outputIndex,
                        item: {
                            type: 'function_call',
                            id: itemId,
                            call_id: callId,
                            name: tc.function.name,
                            status: 'in_progress',
                            arguments: ''
                        }
                    }
                });
            }

            // tool call 参数增量
            if (tc.function?.arguments) {
                const itemId = state.toolCallItemIds.get(tcIndex);
                const prevArgs = state.toolCallArgs.get(tcIndex) || '';
                state.toolCallArgs.set(tcIndex, prevArgs + tc.function.arguments);

                events.push({
                    event: 'response.function_call_arguments.delta',
                    data: {
                        type: 'response.function_call_arguments.delta',
                        item_id: itemId,
                        delta: tc.function.arguments,
                        output_index: state.outputIndex
                    }
                });
            }
        }
    }

    // finish_reason
    if (choice.finish_reason) {
        // 关闭打开的 reasoning
        if (state.reasoningOpen) {
            events.push({
                event: 'response.reasoning_summary_part.done',
                data: {
                    type: 'response.reasoning_summary_part.done',
                    output_index: state.outputIndex,
                    summary_index: 0,
                    item_id: state.reasoningItemId,
                    part: {type: 'summary_text', text: state.reasoningText}
                }
            });
            const item = {
                type: 'reasoning',
                id: state.reasoningItemId,
                status: 'completed',
                summary: [{type: 'summary_text', text: state.reasoningText}]
            };
            events.push({
                event: 'response.output_item.done',
                data: {
                    type: 'response.output_item.done',
                    output_index: state.outputIndex,
                    item
                }
            });
            addCompletedOutput(item);
            state.outputIndex++;
            state.reasoningOpen = false;
            state.reasoningItemId = null;
            state.reasoningText = '';
        }

        // 关闭打开的 message
        if (state.messageOpen) {
            events.push({
                event: 'response.content_part.done',
                data: {
                    type: 'response.content_part.done',
                    output_index: state.outputIndex,
                    content_index: 0,
                    part: {type: 'output_text', text: state.textBuffer, annotations: []}
                }
            });
            const item = {
                type: 'message',
                id: state.currentMessageId,
                status: 'completed',
                role: 'assistant',
                content: [{type: 'output_text', text: state.textBuffer, annotations: []}]
            };
            events.push({
                event: 'response.output_item.done',
                data: {
                    type: 'response.output_item.done',
                    output_index: state.outputIndex,
                    item
                }
            });
            addCompletedOutput(item);
            state.messageOpen = false;
            state.textBuffer = '';
        }

        // 关闭所有 tool calls
        for (const [tcIdx, itemId] of state.toolCallItemIds) {
            const args = state.toolCallArgs.get(tcIdx) || '{}';
            const name = state.toolCallNames.get(tcIdx) || '';
            const callId = [...state.toolCallIndexByCallId.entries()]
                .find(([, idx]) => idx === tcIdx)?.[0] || '';

            events.push({
                event: 'response.function_call_arguments.done',
                data: {
                    type: 'response.function_call_arguments.done',
                    item_id: itemId,
                    arguments: args,
                    output_index: state.outputIndex
                }
            });
            const item = {
                type: 'function_call',
                id: itemId,
                call_id: callId,
                name,
                status: 'completed',
                arguments: args
            };
            events.push({
                event: 'response.output_item.done',
                data: {
                    type: 'response.output_item.done',
                    output_index: state.outputIndex,
                    item
                }
            });
            addCompletedOutput(item);
        }

        // response.completed
        const hasToolCalls = state.toolCallItemIds.size > 0;
        state.finished = true;
        events.push({
            event: 'response.completed',
            data: {
                type: 'response.completed',
                response: {
                    id: state.responseId,
                    object: 'response',
                    created_at: Math.floor(Date.now() / 1000),
                    status: 'completed',
                    model: data.model || 'unknown',
                    output: state.output,
                    usage: convertUsage(data.usage)
                }
            }
        });
    }

    return events;
}

/* ================= Compact 模式 ================= */

/**
 * 将 Compact 请求转换为标准 Chat Completions 请求
 * @param {Object} compactReq - Compact 请求体 {model, input, instructions, previous_response_id}
 * @returns {Object} Chat Completions 请求体
 */
export function compactRequestToChat(compactReq) {
    const messages = [];

    if (compactReq.instructions) {
        messages.push({role: 'system', content: compactReq.instructions});
    }

    if (typeof compactReq.input === 'string') {
        messages.push({role: 'user', content: compactReq.input});
    } else if (Array.isArray(compactReq.input)) {
        for (const item of compactReq.input) {
            const converted = convertInputItem(item);
            if (converted) messages.push(...(Array.isArray(converted) ? converted : [converted]));
        }
    }

    return {
        model: compactReq.model,
        messages,
        stream: false,
        max_tokens: 4096
    };
}

/**
 * 将 Chat Completions 响应转换为 Compact 响应
 * @param {Object} chatRes - Chat Completions 响应
 * @returns {Object} Compact 响应
 */
export function chatResponseToCompact(chatRes) {
    const choice = chatRes.choices?.[0];
    const message = choice?.message;

    let outputText = '';
    if (message?.content) {
        outputText = message.content;
    }

    return {
        id: `resp_${generateId()}`,
        object: 'response',
        created_at: chatRes.created || Math.floor(Date.now() / 1000),
        output: outputText,
        usage: convertUsage(chatRes.usage),
        error: null
    };
}

/* ================= WS Input 净化 ================= */

/**
 * 净化 Responses API 请求的 input，去除上游 WS 无法解析的 id 引用
 *
 * 客户端（如 CherryStudio）续接对话时，会将上一轮响应的 output items（含 id）
 * 放入新请求的 input。部分上游无法查找这些历史 id，
 * 导致 "text part xxx not found" 错误。
 *
 * 处理策略：
 * - message 类型 → 转换为 EasyInputMessage（{role, content}），去掉 id
 * - output_text / input_text content parts → 去掉 id
 * - function_call 类型 → 保留 call_id，去掉 item id
 * - reasoning 类型 → 去掉 id，保留 summary text
 * - 其他类型 → 透传
 *
 * @param {Array|undefined} input - Responses API 的 input 数组
 * @returns {Array} 净化后的 input 数组
 */
export function sanitizeResponsesInput(input) {
    if (!Array.isArray(input)) return input;

    const result = input.map(item => {
        if (!item || typeof item !== 'object') return item;

        // 已是 EasyInputMessage 格式（有 role 但无 type），直接净化 content
        // developer (OpenAI 系统指令角色) → 上游通用 system
        if (item.role && !item.type) {
            return {
                role: item.role === 'developer' ? 'system' : item.role,
                content: sanitizeContentParts(item.content)
            };
        }

        // message 类型（上一轮响应的 output message item）
        if (item.type === 'message') {
            const role = item.role || 'assistant';
            return {
                role: role === 'developer' ? 'system' : role,
                content: sanitizeContentParts(item.content)
            };
        }

        // function_call → 保留 call_id（tool_result 需要匹配），去掉 item id
        if (item.type === 'function_call') {
            return {
                type: 'function_call',
                call_id: item.call_id || `call_${generateId()}`,
                name: item.name || '',
                arguments: item.arguments || '{}'
            };
        }

        // function_call_output → 保留 call_id
        if (item.type === 'function_call_output') {
            return {
                type: 'function_call_output',
                call_id: item.call_id || '',
                output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '')
            };
        }

        // reasoning → 保留 reasoning 类型，去掉上游无法解析的 id/status
        // DeepSeek/Kimi 要求多轮对话必须回传 reasoning_content，
        // 转为 output_text 会丢失推理标记，导致后续 Chat Completions 转换时无法区分
        if (item.type === 'reasoning') {
            const summary = Array.isArray(item.summary)
                ? item.summary.map(s => ({type: s.type || 'summary_text', text: s.text || ''})).filter(s => s.text)
                : [];
            return {
                type: 'reasoning',
                summary
            };
        }

        // input_text / output_text 顶层 item
        if (item.type === 'input_text' || item.type === 'output_text') {
            return {
                role: item.type === 'output_text' ? 'assistant' : 'user',
                content: [{type: item.type, text: item.text || ''}]
            };
        }

        return item;
    });

    // 火山引擎 Responses API 要求：partial 只能用于 input 数组的最后一条消息
    // 当最后一条消息是 assistant 时，必须设 partial=true（续写模式）
    // 中间的 assistant 消息不能带 partial 字段
    if (result.length > 0) {
        const lastItem = result[result.length - 1];
        if (lastItem?.role === 'assistant' && lastItem.partial === undefined) {
            lastItem.partial = true;
        }
    }

    return result;
}

/**
 * 净化 content parts，去掉 id 和 status 等上游无法解析的字段
 */
function sanitizeContentParts(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content;

    return content.map(part => {
        if (!part || typeof part !== 'object') return part;

        if (part.type === 'output_text' || part.type === 'input_text') {
            return {type: part.type, text: part.text || ''};
        }

        if (part.type === 'input_image') {
            return {type: 'input_image', image_url: part.image_url || part.url || ''};
        }

        if (part.type === 'input_file') {
            return {type: 'input_file', file_data: part.file_data || part.file_url || ''};
        }

        // 其他 part 类型保留 text
        if (part.text) {
            return {type: part.type || 'input_text', text: part.text};
        }

        return part;
    });
}
