export function createAnthropicStreamAccumulator({model = 'unknown'} = {}) {
    const state = {
        id: null,
        model,
        contentByIndex: new Map(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        stopReason: null,
        sawMessage: false
    };

    return {
        feed(event, payload = {}) {
            if (!event || !payload || typeof payload !== 'object') return;

            if (event === 'message_start') {
                const message = payload.message || {};
                state.sawMessage = true;
                state.id = message.id || state.id;
                state.model = message.model || state.model;
                updateUsage(state, message.usage);
                return;
            }

            if (event === 'content_block_start') {
                const block = payload.content_block || {};
                const index = Number.isInteger(payload.index) ? payload.index : state.contentByIndex.size;
                state.contentByIndex.set(index, normalizeBlock(block));
                return;
            }

            if (event === 'content_block_delta') {
                const index = Number.isInteger(payload.index) ? payload.index : 0;
                const block = state.contentByIndex.get(index) || normalizeBlock({});
                applyDelta(block, payload.delta || {});
                state.contentByIndex.set(index, block);
                return;
            }

            if (event === 'message_delta') {
                state.stopReason = payload.delta?.stop_reason || state.stopReason;
                updateUsage(state, payload.usage);
            }
        },

        toAnthropicResponse() {
            if (!state.sawMessage) return null;
            return {
                id: state.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: state.model,
                content: [...state.contentByIndex.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, block]) => finalizeBlock(block))
                    .filter(Boolean),
                stop_reason: state.stopReason || 'end_turn',
                usage: {
                    input_tokens: state.inputTokens,
                    output_tokens: state.outputTokens,
                    cache_read_input_tokens: state.cacheReadInputTokens
                }
            };
        }
    };
}

function normalizeBlock(block = {}) {
    if (block.type === 'tool_use') {
        return {
            type: 'tool_use',
            id: block.id || '',
            name: block.name || '',
            inputJson: block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ''
        };
    }
    if (block.type === 'thinking') {
        return {
            type: 'thinking',
            thinking: block.thinking || '',
            signature: block.signature || ''
        };
    }
    return {
        type: 'text',
        text: block.text || ''
    };
}

function applyDelta(block, delta = {}) {
    if (delta.type === 'text_delta') {
        block.type = 'text';
        block.text = (block.text || '') + (delta.text || '');
        return;
    }
    if (delta.type === 'thinking_delta') {
        block.type = 'thinking';
        block.thinking = (block.thinking || '') + (delta.thinking || '');
        return;
    }
    if (delta.type === 'signature_delta') {
        block.type = 'thinking';
        block.signature = delta.signature || block.signature || '';
        return;
    }
    if (delta.type === 'input_json_delta') {
        block.type = 'tool_use';
        block.inputJson = (block.inputJson || '') + (delta.partial_json || '');
    }
}

function finalizeBlock(block = {}) {
    if (block.type === 'tool_use') {
        return {
            type: 'tool_use',
            id: block.id || '',
            name: block.name || '',
            input: parseObject(block.inputJson)
        };
    }
    if (block.type === 'thinking') {
        return {
            type: 'thinking',
            thinking: block.thinking || '',
            ...(block.signature ? {signature: block.signature} : {})
        };
    }
    if (block.type === 'text') {
        return {type: 'text', text: block.text || ''};
    }
    return null;
}

function parseObject(text) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function updateUsage(state, usage = {}) {
    if (usage.input_tokens !== undefined) state.inputTokens = usage.input_tokens || 0;
    if (usage.output_tokens !== undefined) state.outputTokens = usage.output_tokens || 0;
    if (usage.cache_read_input_tokens !== undefined) {
        state.cacheReadInputTokens = Math.max(state.cacheReadInputTokens, usage.cache_read_input_tokens || 0);
    }
}
