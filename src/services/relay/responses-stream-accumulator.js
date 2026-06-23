import {generateId} from '../../transformer/shared-translator.js';

export function createResponsesStreamAccumulator({model = 'unknown'} = {}) {
    const state = {
        id: null,
        object: 'response',
        createdAt: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model,
        outputByIndex: new Map(),
        itemIndexById: new Map(),
        usage: null,
        sawEvent: false,
        completed: false
    };

    return {
        feed(eventOrPayload, payload) {
            const eventName = resolveEventName(eventOrPayload, payload);
            const data = resolveEventPayload(eventOrPayload, payload);
            if (!eventName || !data || typeof data !== 'object') return;
            state.sawEvent = true;

            if (eventName === 'response.created') {
                updateResponseMetadata(state, data.response);
                return;
            }

            if (eventName === 'response.output_item.added') {
                const index = outputIndex(data, state.outputByIndex.size);
                setOutputItem(state, index, normalizeItem(data.item));
                return;
            }

            if (eventName === 'response.content_part.added') {
                const item = ensureMessageItem(state, data);
                const index = Number.isInteger(data.content_index) ? data.content_index : 0;
                item.content[index] = normalizeContentPart(data.part);
                return;
            }

            if (eventName === 'response.output_text.delta') {
                const item = ensureMessageItem(state, data);
                const index = Number.isInteger(data.content_index) ? data.content_index : 0;
                item.content[index] = item.content[index] || {type: 'output_text', text: '', annotations: []};
                item.content[index].text = (item.content[index].text || '') + (data.delta || '');
                return;
            }

            if (eventName === 'response.content_part.done') {
                const item = ensureMessageItem(state, data);
                const index = Number.isInteger(data.content_index) ? data.content_index : 0;
                item.content[index] = normalizeContentPart(data.part);
                return;
            }

            if (eventName === 'response.reasoning_summary_text.delta') {
                const item = ensureReasoningItem(state, data);
                const index = Number.isInteger(data.summary_index) ? data.summary_index : 0;
                item.summary[index] = item.summary[index] || {type: 'summary_text', text: ''};
                item.summary[index].text = (item.summary[index].text || '') + (data.delta || '');
                return;
            }

            if (eventName === 'response.reasoning_summary_part.done') {
                const item = ensureReasoningItem(state, data);
                const index = Number.isInteger(data.summary_index) ? data.summary_index : 0;
                item.summary[index] = normalizeSummaryPart(data.part);
                return;
            }

            if (eventName === 'response.function_call_arguments.delta') {
                const item = ensureFunctionCallItem(state, data);
                item.arguments = (item.arguments || '') + (data.delta || '');
                return;
            }

            if (eventName === 'response.function_call_arguments.done') {
                const item = ensureFunctionCallItem(state, data);
                if (typeof data.arguments === 'string') item.arguments = data.arguments;
                return;
            }

            if (eventName === 'response.output_item.done') {
                const index = outputIndex(data, state.outputByIndex.size);
                const existing = state.outputByIndex.get(index);
                setOutputItem(state, index, mergeDoneItem(existing, normalizeItem(data.item)));
                return;
            }

            if (eventName === 'response.completed') {
                updateResponseMetadata(state, data.response);
                if (Array.isArray(data.response?.output)) {
                    data.response.output.forEach((item, index) => {
                        setOutputItem(state, index, normalizeItem(item));
                    });
                }
                state.completed = true;
                state.status = data.response?.status || 'completed';
            }
        },

        toResponsesResponse() {
            if (!state.sawEvent && state.outputByIndex.size === 0) return null;
            const output = [...state.outputByIndex.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, item]) => finalizeItem(item, state.completed))
                .filter(Boolean);

            return {
                id: state.id || `resp_${generateId()}`,
                object: state.object || 'response',
                created_at: state.createdAt,
                status: state.completed ? (state.status || 'completed') : 'incomplete',
                model: state.model || model,
                output,
                usage: state.usage || {input_tokens: 0, output_tokens: 0, total_tokens: 0}
            };
        },

        inspect() {
            const items = [...state.outputByIndex.values()];
            return {
                unclosedMessage: items.some((item) => item?.type === 'message' && item.status !== 'completed'),
                unclosedReasoning: items.some((item) => item?.type === 'reasoning' && item.status !== 'completed'),
                partialToolArguments: items
                    .filter((item) => item?.type === 'function_call')
                    .filter((item) => !isValidJsonText(item.arguments))
                    .map((item) => ({
                        itemId: item.id || null,
                        callId: item.call_id || null,
                        name: item.name || '',
                        bytes: Buffer.byteLength(String(item.arguments || ''), 'utf8'),
                        validJson: false
                    }))
            };
        }
    };
}

function resolveEventName(eventOrPayload, payload) {
    if (typeof eventOrPayload === 'string') return eventOrPayload;
    return eventOrPayload?.type || eventOrPayload?.event || payload?.type;
}

function resolveEventPayload(eventOrPayload, payload) {
    if (payload !== undefined) return payload;
    if (eventOrPayload?.data && typeof eventOrPayload.data === 'object') return eventOrPayload.data;
    return eventOrPayload;
}

function updateResponseMetadata(state, response = {}) {
    if (!response || typeof response !== 'object') return;
    if (response.id) state.id = response.id;
    if (response.object) state.object = response.object;
    if (response.created_at) state.createdAt = response.created_at;
    if (response.model) state.model = response.model;
    if (response.status) state.status = response.status;
    if (response.usage) state.usage = response.usage;
}

function outputIndex(data, fallback) {
    return Number.isInteger(data?.output_index) ? data.output_index : fallback;
}

function setOutputItem(state, index, item) {
    if (!item) return;
    state.outputByIndex.set(index, item);
    if (item.id) state.itemIndexById.set(item.id, index);
}

function normalizeItem(item = {}) {
    if (item.type === 'reasoning') {
        return {
            type: 'reasoning',
            id: item.id || `rs_${generateId()}`,
            status: item.status || 'in_progress',
            summary: Array.isArray(item.summary) ? item.summary.map(normalizeSummaryPart) : []
        };
    }

    if (item.type === 'function_call') {
        return {
            type: 'function_call',
            id: item.id || `fc_${generateId()}`,
            call_id: item.call_id || item.id || `call_${generateId()}`,
            name: item.name || '',
            status: item.status || 'in_progress',
            arguments: typeof item.arguments === 'string' ? item.arguments : ''
        };
    }

    return {
        type: 'message',
        id: item.id || `msg_${generateId()}`,
        status: item.status || 'in_progress',
        role: item.role || 'assistant',
        content: Array.isArray(item.content) ? item.content.map(normalizeContentPart) : []
    };
}

function normalizeContentPart(part = {}) {
    return {
        type: part.type || 'output_text',
        text: part.text || '',
        annotations: Array.isArray(part.annotations) ? part.annotations : []
    };
}

function normalizeSummaryPart(part = {}) {
    return {
        type: part.type || 'summary_text',
        text: part.text || ''
    };
}

function mergeDoneItem(existing, doneItem) {
    if (!existing) return {...doneItem, status: doneItem.status || 'completed'};
    if (existing.type !== doneItem.type) return {...doneItem, status: doneItem.status || 'completed'};

    if (doneItem.type === 'function_call' && !doneItem.arguments && existing.arguments) {
        doneItem.arguments = existing.arguments;
    }
    if (doneItem.type === 'message' && doneItem.content.length === 0 && existing.content?.length) {
        doneItem.content = existing.content;
    }
    if (doneItem.type === 'reasoning' && doneItem.summary.length === 0 && existing.summary?.length) {
        doneItem.summary = existing.summary;
    }

    return {...doneItem, status: doneItem.status || 'completed'};
}

function ensureMessageItem(state, data) {
    const index = findItemIndex(state, data);
    const item = state.outputByIndex.get(index) || normalizeItem({
        type: 'message',
        id: data.item_id,
        role: 'assistant',
        content: []
    });
    if (item.type !== 'message') return item;
    setOutputItem(state, index, item);
    return item;
}

function ensureReasoningItem(state, data) {
    const index = findItemIndex(state, data);
    const item = state.outputByIndex.get(index) || normalizeItem({
        type: 'reasoning',
        id: data.item_id,
        summary: []
    });
    if (item.type !== 'reasoning') return item;
    setOutputItem(state, index, item);
    return item;
}

function ensureFunctionCallItem(state, data) {
    const index = findItemIndex(state, data);
    const item = state.outputByIndex.get(index) || normalizeItem({
        type: 'function_call',
        id: data.item_id,
        call_id: data.call_id,
        name: data.name,
        arguments: ''
    });
    if (item.type !== 'function_call') return item;
    setOutputItem(state, index, item);
    return item;
}

function findItemIndex(state, data = {}) {
    if (Number.isInteger(data.output_index)) return data.output_index;
    if (data.item_id && state.itemIndexById.has(data.item_id)) return state.itemIndexById.get(data.item_id);
    return state.outputByIndex.size;
}

function finalizeItem(item, responseCompleted) {
    if (!item || typeof item !== 'object') return null;

    if (item.type === 'message') {
        return {
            type: 'message',
            id: item.id,
            status: 'completed',
            role: item.role || 'assistant',
            content: (item.content || []).map(normalizeContentPart)
        };
    }

    if (item.type === 'reasoning') {
        return {
            type: 'reasoning',
            id: item.id,
            status: responseCompleted || item.status === 'completed' ? 'completed' : 'incomplete',
            summary: (item.summary || []).map(normalizeSummaryPart)
        };
    }

    if (item.type === 'function_call') {
        return {
            type: 'function_call',
            id: item.id,
            call_id: item.call_id || item.id,
            name: item.name || '',
            status: responseCompleted || item.status === 'completed' || isValidJsonText(item.arguments)
                ? 'completed'
                : 'incomplete',
            arguments: typeof item.arguments === 'string' ? item.arguments : ''
        };
    }

    return null;
}

function isValidJsonText(value) {
    if (typeof value !== 'string') return false;
    try {
        JSON.parse(value || '{}');
        return true;
    } catch {
        return false;
    }
}
