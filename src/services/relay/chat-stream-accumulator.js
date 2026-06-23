export function createChatStreamAccumulator({model = 'unknown'} = {}) {
    const state = {
        id: null,
        created: Math.floor(Date.now() / 1000),
        model,
        content: '',
        reasoningContent: '',
        toolCallsByIndex: new Map(),
        finishReason: null,
        usage: null,
        sawChunk: false
    };

    return {
        get created() {
            return state.created;
        },

        feed(chunk) {
            if (!chunk || typeof chunk !== 'object') return;
            state.sawChunk = true;
            if (chunk.id) state.id = state.id || chunk.id;
            if (chunk.created) state.created = chunk.created;
            if (chunk.model) state.model = chunk.model;
            if (chunk.usage) state.usage = chunk.usage;

            const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
            if (!choice) return;
            if (choice.finish_reason) state.finishReason = choice.finish_reason;

            const delta = choice.delta || {};
            if (delta.content) state.content += delta.content;
            if (delta.reasoning_content) state.reasoningContent += delta.reasoning_content;
            if (delta.reasoning) state.reasoningContent += delta.reasoning;
            if (typeof delta.thinking === 'string') state.reasoningContent += delta.thinking;
            if (delta.thinking?.content) state.reasoningContent += delta.thinking.content;

            for (const toolCall of delta.tool_calls || []) {
                const index = Number.isInteger(toolCall.index) ? toolCall.index : 0;
                const current = state.toolCallsByIndex.get(index) || {
                    id: toolCall.id || `call_${index}`,
                    type: toolCall.type || 'function',
                    function: {
                        name: '',
                        arguments: ''
                    }
                };
                if (toolCall.id) current.id = toolCall.id;
                if (toolCall.type) current.type = toolCall.type;
                if (toolCall.function?.name) current.function.name = toolCall.function.name;
                if (toolCall.function?.arguments) current.function.arguments += toolCall.function.arguments;
                state.toolCallsByIndex.set(index, current);
            }
        },

        toChatResponse() {
            if (!state.sawChunk) return null;
            const toolCalls = [...state.toolCallsByIndex.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, toolCall]) => toolCall);
            const message = {
                role: 'assistant',
                content: state.content || (toolCalls.length > 0 ? '' : null)
            };
            if (state.reasoningContent) message.reasoning_content = state.reasoningContent;
            if (toolCalls.length > 0) message.tool_calls = toolCalls;

            return {
                id: state.id || `chatcmpl_${Date.now()}`,
                object: 'chat.completion',
                created: state.created,
                model: state.model,
                choices: [{
                    index: 0,
                    message,
                    finish_reason: state.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop')
                }],
                usage: state.usage || {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
            };
        }
    };
}
