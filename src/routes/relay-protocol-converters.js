import {convertResponsesUsageToChat, mergeConsecutiveAssistantMessages} from '../transformer/responses-translator.js';
import {
    extractCacheHitTokens,
    extractInputTokens,
    mapStopReason,
    openAIUsageToAnthropicUsage
} from '../transformer/shared-translator.js';
import {
    appendChatResponseToCanonical,
    canonicalFromAnthropicResponse,
    canonicalFromChatRequest,
    canonicalFromResponsesResponse,
    renderCanonicalToAnthropic,
    renderCanonicalToChat,
    renderCanonicalToResponses
} from '../services/relay/canonical-session.js';
import {streamAnthropicSSEToChatChunks} from '../services/relay/canonical-stream.js';

export function chatContentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content ? JSON.stringify(content) : '';
    return content
        .map((part) => part?.text || part?.input_text || part?.output_text || '')
        .filter(Boolean)
        .join('\n');
}

export function chatRequestToAnthropic(chatReq) {
    const chatMessages = cloneChatMessages(chatReq.messages || []);
    mergeConsecutiveAssistantMessages(chatMessages);
    const canonical = canonicalFromChatRequest({...chatReq, messages: chatMessages});
    const rendered = renderCanonicalToAnthropic(canonical);

    const payload = {
        ...rendered,
        max_tokens: chatReq.max_tokens || chatReq.max_completion_tokens || 4096,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };
    if (Array.isArray(chatReq.stop)) payload.stop_sequences = chatReq.stop;
    else if (typeof chatReq.stop === 'string') payload.stop_sequences = [chatReq.stop];

    if (!payload.tools || payload.tools.length === 0) delete payload.tools;
    if (!payload.tool_choice) delete payload.tool_choice;
    return payload;
}

export function chatRequestToRelayResponses(chatReq = {}) {
    const chatMessages = cloneChatMessages(chatReq.messages || []);
    mergeConsecutiveAssistantMessages(chatMessages);
    const rendered = renderCanonicalToResponses(canonicalFromChatRequest({...chatReq, messages: chatMessages}));
    const payload = {
        ...rendered,
        stream: chatReq.stream,
        temperature: chatReq.temperature,
        top_p: chatReq.top_p
    };

    if (chatReq.max_tokens !== undefined) payload.max_output_tokens = chatReq.max_tokens;
    if (chatReq.reasoning_effort) payload.reasoning = {effort: chatReq.reasoning_effort};
    if (chatReq.store !== undefined) payload.store = chatReq.store;
    if (chatReq.response_format) payload.text = {format: chatReq.response_format};
    if (!payload.tools || payload.tools.length === 0) {
        delete payload.tools;
        delete payload.tool_choice;
        delete payload.parallel_tool_calls;
    }
    return payload;
}

function cloneChatMessages(messages) {
    return messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        return JSON.parse(JSON.stringify(message));
    });
}

export function anthropicUsageToChatUsage(usage) {
    const promptTokens = extractInputTokens(usage);
    const completionTokens = usage?.output_tokens || 0;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
            cached_tokens: extractCacheHitTokens(usage)
        }
    };
}

export function anthropicStopReasonToChat(stopReason) {
    return {end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls'}[stopReason] || 'stop';
}

export function anthropicResponseToChat(anthropicResponse, modelFallback) {
    const session = canonicalFromAnthropicResponse({
        ...anthropicResponse,
        model: anthropicResponse.model || modelFallback
    });
    const rendered = renderCanonicalToChat(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant')
        || {role: 'assistant', content: null};

    return {
        id: anthropicResponse.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicResponse.model || modelFallback || 'unknown',
        choices: [{index: 0, message, finish_reason: anthropicStopReasonToChat(anthropicResponse.stop_reason)}],
        usage: anthropicUsageToChatUsage(anthropicResponse.usage)
    };
}

export function chatResponseToAnthropic(chatResponse = {}) {
    const choice = chatResponse.choices?.[0];
    if (!choice) {
        return {
            id: chatResponse.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: chatResponse.model || 'unknown',
            content: [{type: 'text', text: 'Empty response from upstream API'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: openAIUsageToAnthropicUsage(chatResponse.usage)
        };
    }

    const session = appendChatResponseToCanonical(
        canonicalFromChatRequest({model: chatResponse.model, messages: []}),
        chatResponse
    );
    const rendered = renderCanonicalToAnthropic(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant');

    return {
        id: chatResponse.id,
        type: 'message',
        role: 'assistant',
        model: chatResponse.model,
        content: message?.content?.length ? message.content : [{type: 'text', text: ''}],
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: openAIUsageToAnthropicUsage(chatResponse.usage)
    };
}

export function chatResponseToRelayResponses(chatResponse = {}) {
    const choice = chatResponse.choices?.[0];
    const session = appendChatResponseToCanonical(
        canonicalFromChatRequest({model: chatResponse.model, messages: []}),
        chatResponse
    );
    const rendered = renderCanonicalToResponses(session);
    const output = [];
    let index = 0;

    for (const item of rendered.input || []) {
        if (item?.role === 'assistant') {
            output.push({
                type: 'message',
                id: `msg_${Date.now()}_${index++}`,
                status: 'completed',
                role: 'assistant',
                content: item.content || []
            });
            continue;
        }
        if (item?.type === 'reasoning') {
            output.push({
                ...item,
                id: item.id || `rs_${Date.now()}_${index++}`,
                status: 'completed'
            });
            continue;
        }
        if (item?.type === 'function_call') {
            output.push({
                ...item,
                id: item.id || `fc_${Date.now()}_${index++}`,
                status: item.status || 'completed'
            });
        }
    }

    return {
        id: `resp_${Date.now()}`,
        object: 'response',
        created_at: chatResponse.created || Math.floor(Date.now() / 1000),
        status: chatResponse.error ? 'failed' : (choice?.finish_reason === 'length' ? 'incomplete' : 'completed'),
        error: chatResponse.error || null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: chatResponse.model || 'unknown',
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
        usage: chatUsageToResponsesUsage(chatResponse.usage),
        user: null,
        metadata: {}
    };
}

export function responsesResponseToRelayChat(response = {}) {
    const session = canonicalFromResponsesResponse(response);
    const rendered = renderCanonicalToChat(session);
    const message = [...(rendered.messages || [])].reverse().find((item) => item?.role === 'assistant')
        || {role: 'assistant', content: null};
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    return {
        id: response.id || `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: response.created_at || Math.floor(Date.now() / 1000),
        model: response.model || 'unknown',
        choices: [{
            index: 0,
            message,
            finish_reason: hasToolCalls ? 'tool_calls' : response.status === 'incomplete' ? 'length' : 'stop'
        }],
        usage: convertResponsesUsageToChat(response.usage)
    };
}

function chatUsageToResponsesUsage(usage = {}) {
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

export async function* anthropicStreamToChatChunks(stream, parseSSEBlock, signal) {
    yield* streamAnthropicSSEToChatChunks(stream, parseSSEBlock, signal);
}
