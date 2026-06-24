/**
 * OpenAI Responses API 格式转换模块
 * 实现 Responses ↔ Chat Completions 双向转换
 * @module core/protocol/responses
 */

import {generateId, isDoubaoSeedModel} from './shared.js';

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

    // 合并连续的 assistant 消息（同一轮中 output_text + function_call 属于同一条 assistant 消息）
    // OpenAI Chat Completions 格式不允许连续的 assistant 消息，
    // 且 DeepSeek 等上游严格要求 tool_calls 消息后紧跟所有 tool 响应
    mergeConsecutiveAssistantMessages(messages);

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
 * 确保 messages 序列符合 OpenAI Chat Completions 格式要求：
 * 1. 不能有连续的 assistant 消息
 * 2. assistant(tool_calls) 后必须紧跟所有对应的 tool 消息
 * 3. 重复的 tool_call_id 不允许
 *
 * 策略：从 tool 消息出发，将 tool_call_id 分组到其所属的 assistant 消息，
 * 然后重新排列为合法的序列。这是唯一能保证 DeepSeek 严格校验通过的方式。
 */
export function mergeConsecutiveAssistantMessages(messages) {
    // === 第一步：去重 ===
    // 1a. 去除重复的 tool 消息（相同 tool_call_id 只保留第一个）
    const seenToolIds = new Set();
    for (let j = messages.length - 1; j >= 0; j--) {
        const msg = messages[j];
        if (msg.role === 'tool' && msg.tool_call_id) {
            if (seenToolIds.has(msg.tool_call_id)) {
                messages.splice(j, 1);
            } else {
                seenToolIds.add(msg.tool_call_id);
            }
        }
    }

    // 1b. 去除完全重复的 assistant 消息（content、tool_calls、reasoning_content 完全相同）
    const seenAssistantKeys = new Set();
    for (let j = messages.length - 1; j >= 0; j--) {
        const msg = messages[j];
        if (msg.role === 'assistant') {
            const key = JSON.stringify({
                c: msg.content,
                tc: (msg.tool_calls || []).map(tc => tc.id).sort(),
                r: msg.reasoning_content
            });
            if (seenAssistantKeys.has(key)) {
                messages.splice(j, 1);
            } else {
                seenAssistantKeys.add(key);
            }
        }
    }

    // === 第二步：合并连续的 assistant 消息 ===
    let i = 0;
    while (i < messages.length - 1) {
        const curr = messages[i];
        const next = messages[i + 1];
        if (curr.role === 'assistant' && next.role === 'assistant') {
            // 合并 content
            const currHasContent = curr.content != null && curr.content !== '';
            const nextHasContent = next.content != null && next.content !== '';
            if (currHasContent && nextHasContent) {
                curr.content = curr.content + '\n' + next.content;
            } else if (nextHasContent) {
                curr.content = next.content;
            } else if (!currHasContent && next.content === '') {
                curr.content = '';
            }

            // 合并 tool_calls（按 id 去重）
            if (next.tool_calls?.length) {
                const existingIds = new Set((curr.tool_calls || []).map(tc => tc.id));
                const newCalls = next.tool_calls.filter(tc => !existingIds.has(tc.id));
                curr.tool_calls = [...(curr.tool_calls || []), ...newCalls];
            }

            // 合并 reasoning_content
            if (next.reasoning_content) {
                curr.reasoning_content = curr.reasoning_content
                    ? curr.reasoning_content + '\n' + next.reasoning_content
                    : next.reasoning_content;
            }

            messages.splice(i + 1, 1);
        } else {
            i++;
        }
    }

    // === 第三步：确保 assistant(tool_calls) 后紧跟对应的 tool 消息 ===
    // 对每个 assistant(tool_calls)，检查紧跟的消息是否是对应的 tool。
    // 如果不是，说明 tool 消息在别处——需要重新排列。
    // 策略：将 tool 消息移到其所属 assistant 的正后方。
    for (let j = 0; j < messages.length; j++) {
        const msg = messages[j];
        if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;

        // 收集紧跟的 tool_call_ids
        const followingToolIds = new Set();
        for (let k = j + 1; k < messages.length && messages[k].role === 'tool'; k++) {
            followingToolIds.add(messages[k].tool_call_id);
        }

        // 找出缺失的 tool_call_ids（有 tool_calls 但没有紧跟的 tool 消息）
        const missingIds = msg.tool_calls
            .map(tc => tc.id)
            .filter(id => !followingToolIds.has(id));

        if (missingIds.length === 0) continue; // 全部 OK

        // 对于缺失的 tool_call_ids，在消息序列中找到对应的 tool 消息，
        // 把它们移到当前 assistant 的正后方
        for (const missingId of missingIds) {
            const toolIdx = messages.findIndex(
                m => m.role === 'tool' && m.tool_call_id === missingId
            );
            if (toolIdx === -1) {
                // 找不到对应的 tool 消息——从 assistant 中移除这个 tool_call
                msg.tool_calls = msg.tool_calls.filter(tc => tc.id !== missingId);
                if (msg.tool_calls.length === 0) {
                    delete msg.tool_calls;
                    if (!msg.content) msg.content = '';
                }
                continue;
            }

            // 从原位置取出 tool 消息
            const [toolMsg] = messages.splice(toolIdx, 1);
            if (toolIdx < j) {
                j--;
            }

            // 插入到当前 assistant 的 tool 消息组之后
            // 找到当前 assistant 后面连续 tool 消息的末尾
            let insertPos = j + 1;
            while (insertPos < messages.length && messages[insertPos].role === 'tool') {
                insertPos++;
            }
            messages.splice(insertPos, 0, toolMsg);

            // splice 后索引可能变了，重新处理
            j--;
            break;
        }
    }

    // === 第四步：再次合并连续 assistant（移动 tool 消息后可能产生新的连续 assistant）===
    i = 0;
    while (i < messages.length - 1) {
        const curr = messages[i];
        const next = messages[i + 1];
        if (curr.role === 'assistant' && next.role === 'assistant') {
            const currHasContent = curr.content != null && curr.content !== '';
            const nextHasContent = next.content != null && next.content !== '';
            if (currHasContent && nextHasContent) {
                curr.content = curr.content + '\n' + next.content;
            } else if (nextHasContent) {
                curr.content = next.content;
            } else if (!currHasContent && next.content === '') {
                curr.content = '';
            }
            if (next.tool_calls?.length) {
                const existingIds = new Set((curr.tool_calls || []).map(tc => tc.id));
                const newCalls = next.tool_calls.filter(tc => !existingIds.has(tc.id));
                curr.tool_calls = [...(curr.tool_calls || []), ...newCalls];
            }
            if (next.reasoning_content) {
                curr.reasoning_content = curr.reasoning_content
                    ? curr.reasoning_content + '\n' + next.reasoning_content
                    : next.reasoning_content;
            }
            messages.splice(i + 1, 1);
        } else {
            i++;
        }
    }

    // === 第五步：去除没有对应 assistant tool_calls 的孤立 tool 消息 ===
    const allToolCallIds = new Set();
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) allToolCallIds.add(tc.id);
        }
    }
    for (let j = messages.length - 1; j >= 0; j--) {
        if (messages[j].role === 'tool' && messages[j].tool_call_id && !allToolCallIds.has(messages[j].tool_call_id)) {
            messages.splice(j, 1);
        }
    }

    // Chat 兼容上游通常允许 assistant(tool_calls).content 为 null，
    // 但 Kimi/DeepSeek 等严格实现要求这里是字符串。
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.tool_calls?.length && msg.content == null) {
            msg.content = '';
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

    // {type: "reasoning", ...} — 思维链
    // DeepSeek 等模型要求：当进行了工具调用时，reasoning_content 必须在后续所有请求中回传，
    // 否则 API 返回 400。同时，缺少 reasoning_content 会导致 conversation state 合并时
    // 消息去重失败，产生重复的 assistant 消息。
    if (item.type === 'reasoning') {
        const reasoningText = Array.isArray(item.summary)
            ? item.summary.map(s => s.text || '').filter(Boolean).join('\n')
            : '';
        if (!reasoningText) return null;
        return {role: 'assistant', reasoning_content: reasoningText};
    }

    // {type: "function_call", ...} — 工具调用
    if (item.type === 'function_call') {
        return {
            role: 'assistant',
            content: item.content ?? '',
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
                content: toolCalls.length > 0 ? (textParts.join('') || '') : (textParts.join('') || null),
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

export const DEFAULT_RESPONSES_INPUT_ITEMS_LIMIT = 500;
export const MAX_RESPONSES_INPUT_ITEMS_LIMIT = 950;
export const MIN_RESPONSES_INPUT_ITEMS_LIMIT = 50;

export function resolveResponsesInputItemsLimit(value = process.env.RELAY_RESPONSES_INPUT_ITEMS_LIMIT) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESPONSES_INPUT_ITEMS_LIMIT;
    return Math.min(MAX_RESPONSES_INPUT_ITEMS_LIMIT, Math.max(MIN_RESPONSES_INPUT_ITEMS_LIMIT, parsed));
}

export function truncateResponsesInputItems(input, {limit, preserveLeadingInstructions = false} = {}) {
    if (!Array.isArray(input)) {
        return {
            input,
            truncated: false,
            originalLength: 0,
            retainedLength: 0,
            droppedCount: 0,
            startIndex: 0,
            limit: normalizeExplicitInputItemsLimit(limit)
        };
    }

    const resolvedLimit = normalizeExplicitInputItemsLimit(limit);
    const originalLength = input.length;
    if (originalLength <= resolvedLimit) {
        return {
            input,
            truncated: false,
            originalLength,
            retainedLength: originalLength,
            droppedCount: 0,
            startIndex: 0,
            limit: resolvedLimit
        };
    }

    const rawStart = originalLength - resolvedLimit;
    if (preserveLeadingInstructions) {
        const leadingInstructionsEnd = findLeadingInstructionPrefixEnd(input);
        if (leadingInstructionsEnd > 0 && leadingInstructionsEnd < resolvedLimit) {
            const tailLimit = resolvedLimit - leadingInstructionsEnd;
            const tailRawStart = Math.max(leadingInstructionsEnd, originalLength - tailLimit);
            const tailStartIndex = findResponsesInputCutIndex(input, tailRawStart);
            const truncatedInput = [
                ...input.slice(0, leadingInstructionsEnd),
                ...input.slice(tailStartIndex)
            ];

            return {
                input: truncatedInput,
                truncated: true,
                originalLength,
                retainedLength: truncatedInput.length,
                droppedCount: originalLength - truncatedInput.length,
                startIndex: tailStartIndex,
                preservedPrefixLength: leadingInstructionsEnd,
                limit: resolvedLimit
            };
        }
    }

    const startIndex = findResponsesInputCutIndex(input, rawStart);
    const truncatedInput = input.slice(startIndex);

    return {
        input: truncatedInput,
        truncated: true,
        originalLength,
        retainedLength: truncatedInput.length,
        droppedCount: originalLength - truncatedInput.length,
        startIndex,
        limit: resolvedLimit
    };
}

export function limitResponsesInputItems(payload, {limit, previousResponseId} = {}) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.input)) {
        return {
            payload,
            input: payload?.input,
            truncated: false,
            originalLength: Array.isArray(payload?.input) ? payload.input.length : 0,
            retainedLength: Array.isArray(payload?.input) ? payload.input.length : 0,
            droppedCount: 0,
            previousResponseId: normalizeResponseId(payload?.previous_response_id) || normalizeResponseId(previousResponseId)
        };
    }

    const explicitPreviousResponseId = normalizeResponseId(payload.previous_response_id);
    const continuationResponseId = explicitPreviousResponseId || normalizeResponseId(previousResponseId);
    if (!continuationResponseId) {
        const hardCapped = truncateResponsesInputItems(payload.input, {limit, preserveLeadingInstructions: true});
        if (hardCapped.truncated) {
            return {
                ...hardCapped,
                payload: {
                    ...payload,
                    input: hardCapped.input
                },
                previousResponseId: null
            };
        }

        return {
            payload,
            input: payload.input,
            truncated: false,
            originalLength: payload.input.length,
            retainedLength: payload.input.length,
            droppedCount: 0,
            previousResponseId: null
        };
    }

    const truncated = truncateResponsesInputItems(payload.input, {limit});
    if (!truncated.truncated) {
        return {
            ...truncated,
            payload,
            previousResponseId: continuationResponseId
        };
    }

    return {
        ...truncated,
        payload: {
            ...payload,
            input: truncated.input,
            previous_response_id: explicitPreviousResponseId || continuationResponseId
        },
        previousResponseId: explicitPreviousResponseId || continuationResponseId
    };
}

function normalizeExplicitInputItemsLimit(value) {
    if (value === undefined || value === null) return resolveResponsesInputItemsLimit();
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return resolveResponsesInputItemsLimit();
    return Math.min(MAX_RESPONSES_INPUT_ITEMS_LIMIT, parsed);
}

function findLeadingInstructionPrefixEnd(input) {
    let end = 0;
    while (end < input.length && isLeadingInstructionItem(input[end])) {
        end++;
    }
    return end;
}

function findResponsesInputCutIndex(input, rawStart) {
    const start = Math.min(input.length - 1, Math.max(0, rawStart));
    for (let i = start; i < input.length; i++) {
        if (isPreferredResponsesInputBoundary(input[i])) return i;
    }
    for (let i = start; i < input.length; i++) {
        if (isSafeResponsesInputBoundary(input[i])) return i;
    }
    return start;
}

function isLeadingInstructionItem(item) {
    return item?.role === 'system' || item?.role === 'developer';
}

function isPreferredResponsesInputBoundary(item) {
    return item?.role === 'user' || item?.role === 'system' || item?.role === 'developer';
}

function isSafeResponsesInputBoundary(item) {
    return item?.type !== 'function_call_output' && item?.type !== 'reasoning';
}

function normalizeResponseId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 净化 Responses API 请求的 input，去除上游 WS 无法解析的 id 引用
 *
 * 客户端（如 Codex）续接对话时，会将上一轮响应的 output items（含 id）
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
 * @param {string} [model] - 上游模型名，用于判断是否注入 partial（仅 doubao-seed 系列支持续写模式）
 * @returns {Array} 净化后的 input 数组
 */
export function sanitizeResponsesInput(input, model) {
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

    // 火山引擎 Responses API 对 input 尾部消息有模型相关约束：
    // - doubao-seed 系列：支持 partial（prefill）续写，最后一条 assistant 消息可保留并注入 partial:true
    // - 其他模型（如 glm）：不支持 prefill，最后一条消息不能是 assistant 角色，否则上游 400：
    //   "The last message cannot be from the assistant for a model that does not support prefill"
    //   此时丢弃尾部 assistant 消息，让 input 退回以 user 结尾的合法形态（符合官方文档 input 约定）。
    if (result.length > 0) {
        const lastItem = result[result.length - 1];
        if (lastItem?.role === 'assistant') {
            if (lastItem.partial === undefined && isDoubaoSeedModel(model)) {
                lastItem.partial = true;
            } else if (!isDoubaoSeedModel(model)) {
                // 不支持 prefill 的模型：移除尾部 assistant，避免上游 400
                result.pop();
            }
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
