import {convertResponsesUsageToChat} from '../responses.js';
import {
    extractCacheHitTokens,
    extractInputTokens,
    generateId,
    mapStopReason
} from '../shared.js';

export function createResponsesCanonicalStreamState({model = 'unknown'} = {}) {
    return {
        model,
        responseId: null,
        toolCalls: new Map(),
        nextToolIndex: 0,
        completed: false
    };
}

export function createCanonicalToChatStreamState({model = 'unknown'} = {}) {
    return {
        chatId: `chatcmpl_${generateId()}`,
        created: Math.floor(Date.now() / 1000),
        model,
        roleSent: false,
        toolCalls: new Map(),
        sawToolCall: false,
        completed: false
    };
}

export function createResponsesToChatStreamBridge({model = 'unknown'} = {}) {
    const responsesState = createResponsesCanonicalStreamState({model});
    const chatState = createCanonicalToChatStreamState({model});

    return {
        feed(eventName, eventData) {
            const canonicalEvents = responsesEventToCanonicalStreamEvents(eventName, eventData, responsesState);
            return renderCanonicalStreamEventsToChatChunks(canonicalEvents, chatState);
        },

        finish() {
            if (chatState.completed) return [];
            return renderCanonicalStreamEventsToChatChunks([{
                type: 'completed',
                finishReason: chatState.sawToolCall ? 'tool_calls' : 'stop'
            }], chatState);
        },

        get completed() {
            return chatState.completed;
        }
    };
}

export function createResponsesToResponsesStreamBridge({model = 'unknown'} = {}) {
    const responsesSourceState = createResponsesCanonicalStreamState({model});
    const responsesTargetState = createCanonicalToResponsesStreamState({model});

    return {
        feed(eventName, eventData) {
            const canonicalEvents = responsesEventToCanonicalStreamEvents(eventName, eventData, responsesSourceState);
            return renderCanonicalStreamEventsToResponsesEvents(canonicalEvents, responsesTargetState);
        },

        finish() {
            if (responsesTargetState.finished) return [];
            return renderCanonicalStreamEventsToResponsesEvents([{
                type: 'completed',
                finishReason: responsesTargetState.toolCalls.size > 0 ? 'tool_calls' : 'stop',
                model: responsesSourceState.model
            }], responsesTargetState);
        },

        get finished() {
            return responsesTargetState.finished;
        }
    };
}

export function createResponsesToAnthropicStreamBridge({model = 'unknown'} = {}) {
    const responsesState = createResponsesCanonicalStreamState({model});
    const anthropicState = createCanonicalToAnthropicStreamState({model});

    return {
        feed(eventName, eventData) {
            const canonicalEvents = responsesEventToCanonicalStreamEvents(eventName, eventData, responsesState);
            return renderCanonicalStreamEventsToAnthropicEvents(canonicalEvents, anthropicState);
        },

        finish() {
            if (anthropicState.finished) return [];
            return renderCanonicalStreamEventsToAnthropicEvents([{
                type: 'completed',
                finishReason: responsesState.toolCalls.size > 0 ? 'tool_calls' : 'stop',
                model: responsesState.model
            }], anthropicState);
        },

        get finished() {
            return anthropicState.finished;
        }
    };
}

export function createChatToResponsesStreamBridge({model = 'unknown'} = {}) {
    const chatState = createChatCanonicalStreamState({model});
    const responsesState = createCanonicalToResponsesStreamState({model});

    return {
        feed(chunk) {
            const canonicalEvents = chatChunkToCanonicalStreamEvents(chunk, chatState);
            return renderCanonicalStreamEventsToResponsesEvents(canonicalEvents, responsesState);
        },

        finish() {
            if (responsesState.finished) return [];
            return renderCanonicalStreamEventsToResponsesEvents([{
                type: 'completed',
                finishReason: responsesState.toolCalls.size > 0 ? 'tool_calls' : 'stop'
            }], responsesState);
        },

        get finished() {
            return responsesState.finished;
        }
    };
}

export function createAnthropicToResponsesStreamBridge({model = 'unknown'} = {}) {
    const anthropicState = createAnthropicCanonicalStreamState({model});
    const responsesState = createCanonicalToResponsesStreamState({model});

    return {
        feed(eventName, eventData) {
            const canonicalEvents = anthropicEventToCanonicalStreamEvents(eventName, eventData, anthropicState);
            return renderCanonicalStreamEventsToResponsesEvents(canonicalEvents, responsesState);
        },

        finish() {
            if (responsesState.finished) return [];
            return renderCanonicalStreamEventsToResponsesEvents([{
                type: 'completed',
                finishReason: responsesState.toolCalls.size > 0 ? 'tool_calls' : 'stop',
                usage: anthropicUsageToResponsesUsage({
                    input_tokens: anthropicState.inputTokens,
                    cache_read_input_tokens: anthropicState.cacheHitTokens,
                    output_tokens: 0
                }),
                model: anthropicState.model
            }], responsesState);
        },

        get finished() {
            return responsesState.finished;
        }
    };
}

export function createChatToAnthropicStreamBridge({model = 'unknown'} = {}) {
    const chatState = createChatCanonicalStreamState({model});
    const anthropicState = createCanonicalToAnthropicStreamState({model});

    return {
        feed(chunk) {
            const canonicalEvents = chatChunkToCanonicalStreamEvents(chunk, chatState);
            return renderCanonicalStreamEventsToAnthropicEvents(canonicalEvents, anthropicState);
        },

        finish() {
            if (anthropicState.finished) return [];
            return renderCanonicalStreamEventsToAnthropicEvents([{
                type: 'completed',
                finishReason: chatState.toolCalls.size > 0 ? 'tool_calls' : 'stop'
            }], anthropicState);
        },

        get finished() {
            return anthropicState.finished;
        }
    };
}

export function createAnthropicCanonicalStreamState({model = 'unknown'} = {}) {
    return {
        messageId: null,
        model,
        toolCalls: new Map(),
        nextToolIndex: 0,
        inputTokens: 0,
        cacheHitTokens: 0,
        completed: false
    };
}

export function createAnthropicToChatStreamBridge({model = 'unknown'} = {}) {
    const anthropicState = createAnthropicCanonicalStreamState({model});
    const chatState = createCanonicalToChatStreamState({model});

    return {
        feed(eventName, eventData) {
            const canonicalEvents = anthropicEventToCanonicalStreamEvents(eventName, eventData, anthropicState);
            return renderCanonicalStreamEventsToChatChunks(canonicalEvents, chatState);
        },

        finish() {
            if (chatState.completed) return [];
            return renderCanonicalStreamEventsToChatChunks([{
                type: 'completed',
                finishReason: 'stop',
                usage: anthropicUsageToResponsesUsage({
                    input_tokens: anthropicState.inputTokens,
                    cache_read_input_tokens: anthropicState.cacheHitTokens,
                    output_tokens: 0
                }),
                model: anthropicState.model
            }], chatState);
        },

        get completed() {
            return chatState.completed;
        }
    };
}

export async function* streamAnthropicSSEToChatChunks(stream, parseSSEBlock, signal) {
    const bridge = createAnthropicToChatStreamBridge();
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
            const eventName = event || parsed?.type;
            for (const chatChunk of bridge.feed(eventName, parsed)) {
                yield chatChunk;
            }
        }
    }
}

export function responsesEventToCanonicalStreamEvents(eventName, eventData = {}, state = createResponsesCanonicalStreamState()) {
    if (!eventName) return [];

    if (eventName === 'response.created') {
        state.responseId = eventData.response?.id || state.responseId;
        state.model = eventData.response?.model || state.model;
        return [{
            type: 'metadata',
            responseId: state.responseId,
            model: state.model
        }];
    }

    if (eventName === 'response.output_item.added' && eventData.item?.type === 'function_call') {
        ensureResponsesToolCall(state, eventData.item);
        return [];
    }

    if (eventName === 'response.output_item.done' && eventData.item?.type === 'function_call') {
        ensureResponsesToolCall(state, eventData.item);
        return [];
    }

    if (eventName === 'response.output_item.done' && eventData.item?.type === 'reasoning') {
        return responsesReasoningSignatureEvents(eventData.item);
    }

    if (eventName === 'response.reasoning_summary_text.delta') {
        return [{type: 'reasoning_delta', text: eventData.delta || ''}];
    }

    if (eventName === 'response.output_text.delta') {
        return [{type: 'text_delta', text: eventData.delta || ''}];
    }

    if (eventName === 'response.function_call_arguments.delta') {
        const toolCall = findResponsesToolCall(state, eventData.item_id);
        if (!toolCall) return [];
        toolCall.argumentsText += eventData.delta || '';
        return [canonicalToolEvent('tool_call_arguments_delta', toolCall, {
            argumentsDelta: eventData.delta || ''
        })];
    }

    if (eventName === 'response.function_call_arguments.done') {
        const toolCall = findResponsesToolCall(state, eventData.item_id);
        if (!toolCall) return [];
        if (typeof eventData.arguments === 'string') toolCall.argumentsText = eventData.arguments;
        return [canonicalToolEvent('tool_call_arguments_done', toolCall, {
            argumentsText: toolCall.argumentsText
        })];
    }

    if (eventName === 'response.completed') {
        state.completed = true;
        state.model = eventData.response?.model || state.model;
        const events = [];
        for (const item of eventData.response?.output || []) {
            if (item?.type !== 'function_call') continue;
            const toolCall = ensureResponsesToolCall(state, item);
            if (typeof item.arguments === 'string') toolCall.argumentsText = item.arguments;
            events.push(canonicalToolEvent('tool_call_arguments_done', toolCall, {
                argumentsText: toolCall.argumentsText
            }));
        }
        events.push({
            type: 'completed',
            finishReason: state.toolCalls.size > 0 ? 'tool_calls' : 'stop',
            usage: eventData.response?.usage,
            model: state.model
        });
        return events;
    }

    return [];
}

export function anthropicEventToCanonicalStreamEvents(eventName, eventData = {}, state = createAnthropicCanonicalStreamState()) {
    if (!eventName) return [];

    if (eventName === 'message_start') {
        const message = eventData.message || {};
        state.messageId = message.id || state.messageId;
        state.model = message.model || state.model;
        if (message.usage?.input_tokens !== undefined) state.inputTokens = message.usage.input_tokens || 0;
        state.cacheHitTokens = extractCacheHitTokens(message.usage);
        return [{
            type: 'metadata',
            messageId: state.messageId,
            model: state.model
        }];
    }

    if (eventName === 'content_block_start') {
        const block = eventData.content_block || {};
        if (block.type !== 'tool_use') return [];
        const toolCall = ensureAnthropicToolCall(state, eventData.index, block);
        return [canonicalToolEvent('tool_call_start', toolCall)];
    }

    if (eventName === 'content_block_delta') {
        const delta = eventData.delta || {};
        if (delta.type === 'text_delta') return [{type: 'text_delta', text: delta.text || ''}];
        if (delta.type === 'thinking_delta') return [{type: 'reasoning_delta', text: delta.thinking || ''}];
        if (delta.type === 'signature_delta' && delta.signature) {
            return [{type: 'reasoning_signature', signature: delta.signature}];
        }
        if (delta.type === 'input_json_delta') {
            const toolCall = ensureAnthropicToolCall(state, eventData.index);
            const argumentsDelta = delta.partial_json || '';
            toolCall.argumentsText += argumentsDelta;
            return [canonicalToolEvent('tool_call_arguments_delta', toolCall, {argumentsDelta})];
        }
    }

    if (eventName === 'message_delta') {
        const usage = eventData.usage || {};
        if (usage.input_tokens !== undefined) state.inputTokens = usage.input_tokens || 0;
        state.cacheHitTokens = Math.max(state.cacheHitTokens || 0, extractCacheHitTokens(usage));
        state.completed = true;
        return [{
            type: 'completed',
            finishReason: anthropicStopReasonToChat(eventData.delta?.stop_reason),
            usage: anthropicUsageToResponsesUsage({
                input_tokens: state.inputTokens,
                cache_read_input_tokens: state.cacheHitTokens || 0,
                output_tokens: usage.output_tokens || 0
            }),
            model: state.model
        }];
    }

    if (eventName === 'message_stop' && !state.completed) {
        state.completed = true;
        return [{
            type: 'completed',
            finishReason: 'stop',
            usage: anthropicUsageToResponsesUsage({
                input_tokens: state.inputTokens,
                cache_read_input_tokens: state.cacheHitTokens || 0,
                output_tokens: 0
            }),
            model: state.model
        }];
    }

    return [];
}

function responsesReasoningSignatureEvents(item = {}) {
    if (!Array.isArray(item.x_relay_anthropic_thinking)) return [];
    return item.x_relay_anthropic_thinking
        .map((block) => block?.type === 'thinking' && block.signature
            ? {type: 'reasoning_signature', signature: block.signature}
            : null)
        .filter(Boolean);
}

export function renderCanonicalStreamEventsToChatChunks(canonicalEvents = [], state = createCanonicalToChatStreamState()) {
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
        if (state.roleSent) return;
        chunks.push(buildChunk({role: 'assistant'}));
        state.roleSent = true;
    };

    const ensureChatToolCall = (event) => {
        state.sawToolCall = true;
        let toolCall = state.toolCalls.get(event.canonicalToolCallId);
        if (!toolCall) {
            toolCall = {
                index: event.index,
                id: event.ids?.openAIChatToolCallId
                    || event.ids?.responsesCallId
                    || event.ids?.responsesItemId
                    || event.ids?.anthropicToolUseId
                    || event.canonicalToolCallId,
                name: event.name || '',
                emitted: false,
                emittedArgs: '',
                finalArgs: ''
            };
            state.toolCalls.set(event.canonicalToolCallId, toolCall);
        }
        if (event.ids?.openAIChatToolCallId) toolCall.id = event.ids.openAIChatToolCallId;
        if (event.ids?.responsesCallId) toolCall.id = event.ids.responsesCallId;
        if (event.ids?.anthropicToolUseId) toolCall.id = event.ids.anthropicToolUseId;
        if (event.name) toolCall.name = event.name;
        return toolCall;
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

    const emitToolArguments = (toolCall, argsText) => {
        if (!argsText) return;
        ensureToolCallStart(toolCall);
        chunks.push(buildChunk({
            tool_calls: [{
                index: toolCall.index,
                function: {arguments: argsText}
            }]
        }));
        toolCall.emittedArgs += argsText;
    };

    for (const event of canonicalEvents) {
        if (!event || typeof event !== 'object') continue;

        if (event.type === 'metadata') {
            if (event.model) state.model = event.model;
            if (event.messageId) state.chatId = event.messageId;
            continue;
        }

        if (event.type === 'reasoning_delta') {
            ensureAssistantRole();
            chunks.push(buildChunk({reasoning_content: event.text || ''}));
            continue;
        }

        if (event.type === 'text_delta') {
            ensureAssistantRole();
            chunks.push(buildChunk({content: event.text || ''}));
            continue;
        }

        if (event.type === 'tool_call_start') {
            const toolCall = ensureChatToolCall(event);
            ensureToolCallStart(toolCall);
            continue;
        }

        if (event.type === 'tool_call_arguments_delta') {
            const toolCall = ensureChatToolCall(event);
            toolCall.finalArgs += event.argumentsDelta || '';
            emitToolArguments(toolCall, event.argumentsDelta || '');
            continue;
        }

        if (event.type === 'tool_call_arguments_done') {
            const toolCall = ensureChatToolCall(event);
            if (typeof event.argumentsText === 'string') toolCall.finalArgs = event.argumentsText;
            const pendingArgs = pendingToolArguments(toolCall);
            emitToolArguments(toolCall, pendingArgs);
            continue;
        }

        if (event.type === 'completed') {
            if (event.model) state.model = event.model;
            state.completed = true;
            chunks.push(buildChunk(
                {},
                event.finishReason || (state.sawToolCall ? 'tool_calls' : 'stop'),
                event.usage ? convertResponsesUsageToChat(event.usage) : undefined
            ));
        }
    }

    return chunks;
}

export function createChatCanonicalStreamState({model = 'unknown'} = {}) {
    return {
        model,
        started: false,
        toolCalls: new Map()
    };
}

export function createCanonicalToResponsesStreamState({model = 'unknown'} = {}) {
    return {
        responseId: `resp_${generateId()}`,
        createdAt: Math.floor(Date.now() / 1000),
        model,
        started: false,
        finished: false,
        outputIndex: 0,
        reasoningOpen: false,
        reasoningItemId: null,
        reasoningText: '',
        reasoningSignature: null,
        messageOpen: false,
        currentMessageId: null,
        textBuffer: '',
        toolCalls: new Map(),
        output: []
    };
}

export function createCanonicalToAnthropicStreamState({model = 'unknown'} = {}) {
    return {
        messageId: null,
        model,
        messageStartSent: false,
        contentBlockOpen: false,
        contentBlockIndex: 0,
        currentBlockType: null,
        thinkingHasSignature: false,
        toolCalls: new Map(),
        finished: false
    };
}

export function chatChunkToCanonicalStreamEvents(chunk = {}, state = createChatCanonicalStreamState()) {
    if (!chunk || typeof chunk !== 'object') return [];
    const events = [];
    if (!state.started) {
        state.started = true;
        state.model = chunk.model || state.model;
        events.push({type: 'metadata', model: state.model, messageId: chunk.id, chatUsage: chunk.usage});
    } else if (chunk.model) {
        state.model = chunk.model;
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return events;
    const delta = choice.delta || {};

    const reasoningText = extractChatReasoningText(delta);
    if (reasoningText) events.push({type: 'reasoning_delta', text: reasoningText});
    if (delta.content && !delta.reasoning_content) events.push({type: 'text_delta', text: delta.content});

    if (Array.isArray(delta.tool_calls)) {
        for (const toolCallDelta of delta.tool_calls) {
            const index = Number.isInteger(toolCallDelta.index) ? toolCallDelta.index : 0;
            const current = ensureChatToolCall(state, index, toolCallDelta);
            if (toolCallDelta.id || toolCallDelta.function?.name) {
                events.push(canonicalToolEvent('tool_call_start', current));
            }
            if (toolCallDelta.function?.arguments) {
                current.argumentsText += toolCallDelta.function.arguments;
                events.push(canonicalToolEvent('tool_call_arguments_delta', current, {
                    argumentsDelta: toolCallDelta.function.arguments
                }));
            }
        }
    }

    if (choice.finish_reason) {
        events.push({
            type: 'completed',
            finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
            usage: chatUsageToResponsesUsage(chunk.usage),
            chatUsage: chunk.usage,
            model: state.model
        });
    }

    return events;
}

function extractChatReasoningText(delta = {}) {
    for (const value of [delta.reasoning_content, delta.reasoning, delta.thinking, delta.thought]) {
        if (typeof value === 'string' && value) return value;
        if (value && typeof value === 'object') {
            const text = value.content || value.text || value.thinking;
            if (typeof text === 'string' && text) return text;
        }
    }
    return '';
}

export function renderCanonicalStreamEventsToResponsesEvents(canonicalEvents = [], state = createCanonicalToResponsesStreamState()) {
    const events = [];

    const push = (event, data) => events.push({event, data});

    const ensureStarted = (model) => {
        if (model) state.model = model;
        if (state.started) return;
        state.started = true;
        push('response.created', {
            type: 'response.created',
            response: {
                id: state.responseId,
                object: 'response',
                created_at: state.createdAt,
                status: 'in_progress',
                model: state.model || 'unknown',
                output: [],
                parallel_tool_calls: true
            }
        });
    };

    const closeReasoning = () => {
        if (!state.reasoningOpen) return;
        push('response.reasoning_summary_part.done', {
            type: 'response.reasoning_summary_part.done',
            output_index: state.outputIndex,
            summary_index: 0,
            item_id: state.reasoningItemId,
            part: {type: 'summary_text', text: state.reasoningText}
        });
        const item = {
            type: 'reasoning',
            id: state.reasoningItemId,
            status: 'completed',
            summary: [{type: 'summary_text', text: state.reasoningText}],
            ...(state.reasoningSignature ? {
                x_relay_anthropic_thinking: [{
                    type: 'thinking',
                    thinking: state.reasoningText,
                    signature: state.reasoningSignature
                }]
            } : {})
        };
        push('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.outputIndex,
            item
        });
        state.output.push(item);
        state.outputIndex++;
        state.reasoningOpen = false;
        state.reasoningItemId = null;
        state.reasoningText = '';
        state.reasoningSignature = null;
    };

    const closeMessage = () => {
        if (!state.messageOpen) return;
        push('response.content_part.done', {
            type: 'response.content_part.done',
            output_index: state.outputIndex,
            content_index: 0,
            part: {type: 'output_text', text: state.textBuffer, annotations: []}
        });
        const item = {
            type: 'message',
            id: state.currentMessageId,
            status: 'completed',
            role: 'assistant',
            content: [{type: 'output_text', text: state.textBuffer, annotations: []}]
        };
        push('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.outputIndex,
            item
        });
        state.output.push(item);
        state.outputIndex++;
        state.messageOpen = false;
        state.currentMessageId = null;
        state.textBuffer = '';
    };

    const ensureReasoning = () => {
        closeMessage();
        if (state.reasoningOpen) return;
        state.reasoningOpen = true;
        state.reasoningItemId = `rs_${generateId()}`;
        state.reasoningText = '';
        state.reasoningSignature = null;
        push('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: state.outputIndex,
            item: {type: 'reasoning', id: state.reasoningItemId}
        });
        push('response.reasoning_summary_part.added', {
            type: 'response.reasoning_summary_part.added',
            output_index: state.outputIndex,
            summary_index: 0,
            item_id: state.reasoningItemId,
            part: {type: 'summary_text', text: ''}
        });
    };

    const ensureMessage = () => {
        closeReasoning();
        if (state.messageOpen) return;
        state.messageOpen = true;
        state.currentMessageId = `msg_${generateId()}`;
        state.textBuffer = '';
        push('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: state.outputIndex,
            item: {
                type: 'message',
                id: state.currentMessageId,
                status: 'in_progress',
                role: 'assistant',
                content: []
            }
        });
        push('response.content_part.added', {
            type: 'response.content_part.added',
            output_index: state.outputIndex,
            content_index: 0,
            part: {type: 'output_text', text: '', annotations: []}
        });
    };

    const ensureResponsesToolCall = (event) => {
        closeReasoning();
        closeMessage();
        let toolCall = state.toolCalls.get(event.canonicalToolCallId);
        if (toolCall) return toolCall;
        toolCall = {
            itemId: `fc_${generateId()}`,
            callId: event.ids?.openAIChatToolCallId || event.ids?.responsesCallId || event.canonicalToolCallId,
            name: event.name || '',
            argumentsText: '',
            finalArgs: '',
            emittedArgs: '',
            outputIndex: state.outputIndex,
            done: false
        };
        state.toolCalls.set(event.canonicalToolCallId, toolCall);
        push('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: toolCall.outputIndex,
            item: {
                type: 'function_call',
                id: toolCall.itemId,
                call_id: toolCall.callId,
                name: toolCall.name,
                status: 'in_progress',
                arguments: ''
            }
        });
        return toolCall;
    };

    const emitResponsesToolArguments = (toolCall, argsText) => {
        if (!argsText) return;
        push('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: toolCall.itemId,
            delta: argsText,
            output_index: toolCall.outputIndex
        });
        toolCall.emittedArgs += argsText;
    };

    const closeResponsesToolCall = (toolCall) => {
        if (toolCall.done) return;
        const argumentsText = toolCall.finalArgs || toolCall.argumentsText || '{}';
        push('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            item_id: toolCall.itemId,
            arguments: argumentsText,
            output_index: toolCall.outputIndex
        });
        const item = {
            type: 'function_call',
            id: toolCall.itemId,
            call_id: toolCall.callId,
            name: toolCall.name,
            status: 'completed',
            arguments: argumentsText
        };
        push('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: toolCall.outputIndex,
            item
        });
        state.output.push(item);
        toolCall.done = true;
    };

    const closeToolCalls = () => {
        for (const toolCall of state.toolCalls.values()) {
            closeResponsesToolCall(toolCall);
        }
    };

    for (const event of canonicalEvents) {
        if (!event || typeof event !== 'object') continue;
        ensureStarted(event.model);

        if (event.type === 'metadata') {
            continue;
        }

        if (event.type === 'reasoning_delta') {
            ensureReasoning();
            state.reasoningText += event.text || '';
            push('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta',
                delta: event.text || '',
                output_index: state.outputIndex,
                summary_index: 0,
                item_id: state.reasoningItemId
            });
            continue;
        }

        if (event.type === 'reasoning_signature') {
            if (event.signature) {
                ensureReasoning();
                state.reasoningSignature = event.signature;
            }
            continue;
        }

        if (event.type === 'text_delta') {
            ensureMessage();
            state.textBuffer += event.text || '';
            push('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: state.currentMessageId,
                delta: event.text || '',
                output_index: state.outputIndex,
                content_index: 0
            });
            continue;
        }

        if (event.type === 'tool_call_start') {
            ensureResponsesToolCall(event);
            continue;
        }

        if (event.type === 'tool_call_arguments_delta') {
            const toolCall = ensureResponsesToolCall(event);
            toolCall.argumentsText += event.argumentsDelta || '';
            toolCall.finalArgs = toolCall.argumentsText;
            emitResponsesToolArguments(toolCall, event.argumentsDelta || '');
            continue;
        }

        if (event.type === 'tool_call_arguments_done') {
            const toolCall = ensureResponsesToolCall(event);
            if (typeof event.argumentsText === 'string') {
                toolCall.finalArgs = event.argumentsText;
                toolCall.argumentsText = event.argumentsText;
            }
            emitResponsesToolArguments(toolCall, pendingToolArguments(toolCall));
            continue;
        }

        if (event.type === 'completed') {
            closeReasoning();
            closeMessage();
            closeToolCalls();
            state.finished = true;
            push('response.completed', {
                type: 'response.completed',
                response: {
                    id: state.responseId,
                    object: 'response',
                    created_at: state.createdAt,
                    status: 'completed',
                    model: state.model || 'unknown',
                    output: state.output,
                    usage: event.usage || {input_tokens: 0, output_tokens: 0, total_tokens: 0}
                }
            });
        }
    }

    return events;
}

export function renderCanonicalStreamEventsToAnthropicEvents(canonicalEvents = [], state = createCanonicalToAnthropicStreamState()) {
    const events = [];

    const ensureStarted = (event = {}) => {
        if (event.model) state.model = event.model;
        if (event.messageId) state.messageId = event.messageId;
        if (state.messageStartSent) return;
        const startUsage = event.chatUsage
            ? {...chatUsageToAnthropicUsage(event.chatUsage), output_tokens: 0}
            : {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0};
        state.messageStartSent = true;
        events.push({
            type: 'message_start',
            message: {
                id: state.messageId || `msg_${generateId()}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: state.model || 'unknown',
                stop_reason: null,
                stop_sequence: null,
                usage: startUsage
            }
        });
    };

    const closeCurrentBlock = () => {
        if (!state.contentBlockOpen) return;
        // thinking 块若无真实签名（codebuddy 等 chat 上游 reasoning 没有签名来源），
        // 注入占位签名使块满足 Anthropic 流式签名要求，保留 thinking 展示。
        if (state.currentBlockType === 'thinking' && !state.thinkingHasSignature) {
            events.push({
                type: 'content_block_delta',
                index: state.contentBlockIndex,
                delta: {type: 'signature_delta', signature: generateId()}
            });
        }
        events.push({type: 'content_block_stop', index: state.contentBlockIndex});
        state.contentBlockIndex++;
        state.contentBlockOpen = false;
        state.currentBlockType = null;
        state.thinkingHasSignature = false;
    };

    const ensureBlock = (type, contentBlock) => {
        if (state.contentBlockOpen && state.currentBlockType === type) return;
        closeCurrentBlock();
        events.push({
            type: 'content_block_start',
            index: state.contentBlockIndex,
            content_block: contentBlock
        });
        state.contentBlockOpen = true;
        state.currentBlockType = type;
    };

    const ensureToolBlock = (event) => {
        let toolCall = state.toolCalls.get(event.canonicalToolCallId);
        if (toolCall?.emitted) {
            toolCall.id = event.ids?.openAIChatToolCallId || event.ids?.responsesCallId || toolCall.id;
            toolCall.name = event.name || toolCall.name || '';
            return toolCall;
        }
        closeCurrentBlock();
        toolCall = toolCall || {
            id: event.ids?.openAIChatToolCallId || event.ids?.responsesCallId || event.canonicalToolCallId,
            name: event.name || '',
            blockIndex: state.contentBlockIndex,
            emitted: false,
            emittedArgs: '',
            finalArgs: ''
        };
        toolCall.id = event.ids?.openAIChatToolCallId || toolCall.id;
        toolCall.name = event.name || toolCall.name || '';
        toolCall.blockIndex = state.contentBlockIndex;
        toolCall.emitted = true;
        state.toolCalls.set(event.canonicalToolCallId, toolCall);
        events.push({
            type: 'content_block_start',
            index: state.contentBlockIndex,
            content_block: {
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: {}
            }
        });
        state.contentBlockOpen = true;
        state.currentBlockType = 'tool_use';
        return toolCall;
    };

    for (const event of canonicalEvents) {
        if (!event || typeof event !== 'object') continue;
        ensureStarted(event);

        if (event.type === 'metadata') {
            continue;
        }

        if (event.type === 'reasoning_delta') {
            ensureBlock('thinking', {type: 'thinking', thinking: ''});
            events.push({
                type: 'content_block_delta',
                index: state.contentBlockIndex,
                delta: {type: 'thinking_delta', thinking: event.text || ''}
            });
            continue;
        }

        if (event.type === 'reasoning_signature') {
            if (event.signature) {
                ensureBlock('thinking', {type: 'thinking', thinking: ''});
                events.push({
                    type: 'content_block_delta',
                    index: state.contentBlockIndex,
                    delta: {type: 'signature_delta', signature: event.signature}
                });
                state.thinkingHasSignature = true;
            }
            continue;
        }

        if (event.type === 'text_delta') {
            ensureBlock('text', {type: 'text', text: ''});
            events.push({
                type: 'content_block_delta',
                index: state.contentBlockIndex,
                delta: {type: 'text_delta', text: event.text || ''}
            });
            continue;
        }

        if (event.type === 'tool_call_start') {
            ensureToolBlock(event);
            continue;
        }

        if (event.type === 'tool_call_arguments_delta') {
            const toolCall = ensureToolBlock(event);
            const partialJson = event.argumentsDelta || '';
            toolCall.finalArgs += partialJson;
            toolCall.emittedArgs += partialJson;
            events.push({
                type: 'content_block_delta',
                index: toolCall.blockIndex,
                delta: {type: 'input_json_delta', partial_json: partialJson}
            });
            continue;
        }

        if (event.type === 'tool_call_arguments_done') {
            const toolCall = ensureToolBlock(event);
            if (typeof event.argumentsText === 'string') toolCall.finalArgs = event.argumentsText;
            const pendingArgs = pendingToolArguments(toolCall);
            if (pendingArgs) {
                toolCall.emittedArgs += pendingArgs;
                events.push({
                    type: 'content_block_delta',
                    index: toolCall.blockIndex,
                    delta: {type: 'input_json_delta', partial_json: pendingArgs}
                });
            }
            continue;
        }

        if (event.type === 'completed') {
            closeCurrentBlock();
            state.finished = true;
            const usage = event.chatUsage
                ? chatUsageToAnthropicUsage(event.chatUsage)
                : chatUsageToAnthropicUsage(event.usage ? convertResponsesUsageToChat(event.usage) : undefined);
            events.push({
                type: 'message_delta',
                delta: {
                    stop_reason: mapStopReason(event.finishReason || 'stop'),
                    stop_sequence: null
                },
                usage
            });
            events.push({type: 'message_stop'});
        }
    }

    return events;
}

function ensureResponsesToolCall(state, item = {}) {
    const itemId = item.id || item.item_id || item.call_id || `fc_${generateId()}`;
    let toolCall = state.toolCalls.get(itemId);
    if (!toolCall) {
        toolCall = {
            canonicalToolCallId: `ctc_${state.toolCalls.size + 1}`,
            index: state.nextToolIndex++,
            name: item.name || '',
            argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
            ids: {
                responsesItemId: itemId,
                responsesCallId: item.call_id || itemId
            }
        };
        state.toolCalls.set(itemId, toolCall);
        return toolCall;
    }

    if (item.name) toolCall.name = item.name;
    if (item.call_id) toolCall.ids.responsesCallId = item.call_id;
    if (typeof item.arguments === 'string') toolCall.argumentsText = item.arguments;
    return toolCall;
}

function ensureAnthropicToolCall(state, blockIndex = 0, block = {}) {
    const index = Number.isInteger(blockIndex) ? blockIndex : 0;
    let toolCall = state.toolCalls.get(index);
    if (!toolCall) {
        const toolIndex = state.nextToolIndex++;
        const toolUseId = block.id || `call_${toolIndex}`;
        toolCall = {
            canonicalToolCallId: `ctc_${state.toolCalls.size + 1}`,
            index: toolIndex,
            name: block.name || '',
            argumentsText: '',
            ids: {
                anthropicToolUseId: toolUseId
            }
        };
        state.toolCalls.set(index, toolCall);
        return toolCall;
    }

    if (block.id) toolCall.ids.anthropicToolUseId = block.id;
    if (block.name) toolCall.name = block.name;
    return toolCall;
}

function findResponsesToolCall(state, itemId) {
    if (!itemId) return null;
    return state.toolCalls.get(itemId) || null;
}

function canonicalToolEvent(type, toolCall, extra = {}) {
    return {
        type,
        canonicalToolCallId: toolCall.canonicalToolCallId,
        index: toolCall.index,
        name: toolCall.name || '',
        ids: {...toolCall.ids},
        ...extra
    };
}

function pendingToolArguments(toolCall) {
    const finalArgs = toolCall.finalArgs || '';
    if (!finalArgs) return '';
    if (finalArgs.startsWith(toolCall.emittedArgs)) {
        return finalArgs.slice(toolCall.emittedArgs.length);
    }
    if (!toolCall.emittedArgs) return finalArgs;
    return '';
}

function ensureChatToolCall(state, index, toolCallDelta = {}) {
    let toolCall = state.toolCalls.get(index);
    if (!toolCall) {
        toolCall = {
            canonicalToolCallId: `ctc_${state.toolCalls.size + 1}`,
            index,
            name: '',
            argumentsText: '',
            ids: {
                openAIChatToolCallId: toolCallDelta.id || `call_${index}`
            }
        };
        state.toolCalls.set(index, toolCall);
    }

    if (toolCallDelta.id) toolCall.ids.openAIChatToolCallId = toolCallDelta.id;
    if (toolCallDelta.function?.name) toolCall.name = toolCallDelta.function.name;
    return toolCall;
}

function chatUsageToResponsesUsage(usage) {
    if (!usage) return undefined;
    return {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        input_tokens_details: {
            cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
        },
        output_tokens_details: {
            reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0
        }
    };
}

function chatUsageToAnthropicUsage(usage) {
    if (!usage) return {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0};
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0;
    return {
        input_tokens: Math.max(0, (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || 0)),
        output_tokens: usage.completion_tokens || 0,
        cache_read_input_tokens: cachedTokens
    };
}

function anthropicStopReasonToChat(stopReason) {
    return {
        end_turn: 'stop',
        stop_sequence: 'stop',
        max_tokens: 'length',
        tool_use: 'tool_calls'
    }[stopReason] || 'stop';
}

function anthropicUsageToResponsesUsage(usage) {
    const inputTokens = extractInputTokens(usage);
    const outputTokens = usage?.output_tokens || 0;
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: {
            cached_tokens: extractCacheHitTokens(usage)
        },
        output_tokens_details: {
            reasoning_tokens: 0
        }
    };
}
