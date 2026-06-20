import {createHash} from 'crypto';
import {mergeConsecutiveAssistantMessages} from '../transformer/responses-translator.js';
import {extractCacheHitTokens, extractCacheCreationTokens} from '../transformer/shared-translator.js';

export function chatContentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content ? JSON.stringify(content) : '';
    return content
        .map((part) => part?.text || part?.input_text || part?.output_text || '')
        .filter(Boolean)
        .join('\n');
}

function chatContentToAnthropicBlocks(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return chatContentToText(content);
    const blocks = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            blocks.push({type: 'text', text: part.text || part.input_text || part.output_text || ''});
        } else if (part.type === 'image_url' && part.image_url?.url) {
            blocks.push({type: 'image', source: {type: 'url', url: part.image_url.url}});
        }
    }
    return blocks.length > 0 ? blocks : chatContentToText(content);
}

function chatToolsToAnthropicTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const out = tools
        .filter((tool) => tool?.type === 'function' && tool.function?.name)
        .map((tool) => ({
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || {type: 'object', properties: {}}
        }));
    return out.length > 0 ? out : undefined;
}

function chatToolChoiceToAnthropic(toolChoice) {
    if (!toolChoice) return undefined;
    if (toolChoice === 'auto' || toolChoice === 'none') return {type: toolChoice};
    if (toolChoice === 'required') return {type: 'any'};
    if (toolChoice.type === 'function' && toolChoice.function?.name) {
        return {type: 'tool', name: toolChoice.function.name};
    }
    return undefined;
}

export function chatRequestToAnthropic(chatReq) {
    const messages = [];
    const systemParts = [];
    const chatMessages = cloneChatMessages(chatReq.messages || []);
    mergeConsecutiveAssistantMessages(chatMessages);
    for (const message of chatMessages) {
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'system' || message.role === 'developer') {
            const text = chatContentToText(message.content);
            if (text) systemParts.push(text);
            continue;
        }
        if (message.role === 'tool') {
            messages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: message.tool_call_id || '',
                    content: chatContentToText(message.content)
                }]
            });
            continue;
        }
        if (message.role === 'assistant') {
            const content = [];
            if (message.reasoning_content) content.push({type: 'thinking', thinking: message.reasoning_content});
            const text = chatContentToText(message.content);
            if (text) content.push({type: 'text', text});
            for (const toolCall of message.tool_calls || []) {
                let input = {};
                try { input = JSON.parse(toolCall.function?.arguments || '{}'); } catch { input = {}; }
                content.push({
                    type: 'tool_use',
                    id: toolCall.id || `call_${createHash('sha1').update(`${Date.now()}`).digest('hex').slice(0, 12)}`,
                    name: toolCall.function?.name || '',
                    input
                });
            }
            messages.push({role: 'assistant', content: content.length ? content : [{type: 'text', text: ''}]});
            continue;
        }
        messages.push({role: 'user', content: chatContentToAnthropicBlocks(message.content)});
    }

    const payload = {
        model: chatReq.model,
        messages,
        max_tokens: chatReq.max_tokens || chatReq.max_completion_tokens || 4096,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };
    if (systemParts.length > 0) payload.system = systemParts.join('\n\n');
    if (Array.isArray(chatReq.stop)) payload.stop_sequences = chatReq.stop;
    else if (typeof chatReq.stop === 'string') payload.stop_sequences = [chatReq.stop];

    const tools = chatToolsToAnthropicTools(chatReq.tools);
    if (tools) payload.tools = tools;
    const toolChoice = chatToolChoiceToAnthropic(chatReq.tool_choice);
    if (toolChoice) payload.tool_choice = toolChoice;
    return payload;
}

function cloneChatMessages(messages) {
    return messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        return JSON.parse(JSON.stringify(message));
    });
}

export function anthropicUsageToChatUsage(usage) {
    const promptTokens = usage?.input_tokens || 0;
    const completionTokens = usage?.output_tokens || 0;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
            cached_tokens: extractCacheHitTokens(usage),
            cache_creation_tokens: extractCacheCreationTokens(usage)
        }
    };
}

export function anthropicStopReasonToChat(stopReason) {
    return {end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls'}[stopReason] || 'stop';
}

export function anthropicResponseToChat(anthropicResponse, modelFallback) {
    const textParts = [];
    const toolCalls = [];
    const reasoningParts = [];
    for (const block of anthropicResponse.content || []) {
        if (block?.type === 'text') textParts.push(block.text || '');
        if (block?.type === 'thinking') reasoningParts.push(block.thinking || '');
        if (block?.type === 'tool_use') {
            toolCalls.push({
                id: block.id || `call_${Date.now()}`,
                type: 'function',
                function: {name: block.name || '', arguments: JSON.stringify(block.input || {})}
            });
        }
    }
    const message = {role: 'assistant', content: textParts.join('\n\n') || null};
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('\n\n');
    return {
        id: anthropicResponse.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model || modelFallback || 'unknown',
        choices: [{index: 0, message, finish_reason: anthropicStopReasonToChat(anthropicResponse.stop_reason)}],
        usage: anthropicUsageToChatUsage(anthropicResponse.usage)
    };
}

function makeChatChunk(state, delta, finishReason = null, usage = null) {
    return {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{index: 0, delta, finish_reason: finishReason}],
        ...(usage ? {usage} : {})
    };
}

export async function* anthropicStreamToChatChunks(stream, parseSSEBlock, signal) {
    const state = {
        id: `chatcmpl_${Date.now()}`,
        created: Math.floor(Date.now() / 1000),
        model: 'unknown',
        toolIndexes: new Map(),
        nextToolIndex: 0,
        inputTokens: 0
    };
    let buffer = '';
    for await (const chunk of stream) {
        if (signal?.aborted) break;
        buffer += chunk.toString('utf8');
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) {
            const {event, data} = parseSSEBlock(part);
            if (!data || data === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }
            if (event === 'message_start') {
                const message = parsed.message || {};
                state.id = message.id || state.id;
                state.model = message.model || state.model;
                state.inputTokens = message.usage?.input_tokens || 0;
                yield makeChatChunk(state, {role: 'assistant'});
                continue;
            }
            if (event === 'content_block_start') {
                const block = parsed.content_block || {};
                if (block.type === 'tool_use') {
                    const toolIndex = state.nextToolIndex++;
                    state.toolIndexes.set(parsed.index, toolIndex);
                    yield makeChatChunk(state, {
                        tool_calls: [{
                            index: toolIndex,
                            id: block.id || `call_${toolIndex}`,
                            type: 'function',
                            function: {name: block.name || '', arguments: ''}
                        }]
                    });
                }
                continue;
            }
            if (event === 'content_block_delta') {
                const delta = parsed.delta || {};
                if (delta.type === 'text_delta') yield makeChatChunk(state, {content: delta.text || ''});
                else if (delta.type === 'thinking_delta') yield makeChatChunk(state, {reasoning_content: delta.thinking || ''});
                else if (delta.type === 'input_json_delta') {
                    const toolIndex = state.toolIndexes.get(parsed.index) ?? 0;
                    yield makeChatChunk(state, {tool_calls: [{index: toolIndex, function: {arguments: delta.partial_json || ''}}]});
                }
                continue;
            }
            if (event === 'message_delta') {
                const usage = anthropicUsageToChatUsage({
                    input_tokens: state.inputTokens,
                    output_tokens: parsed.usage?.output_tokens || 0,
                    cache_read_input_tokens: parsed.usage?.cache_read_input_tokens || 0,
                    cache_creation_input_tokens: parsed.usage?.cache_creation_input_tokens || 0
                });
                yield makeChatChunk(state, {}, anthropicStopReasonToChat(parsed.delta?.stop_reason), usage);
            }
        }
    }
}
