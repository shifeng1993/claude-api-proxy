const CHAT_CONTROL_FIELDS = ['previous_response_id', 'store'];

const STRICT_CHAT_FIELDS = new Set([
    'model',
    'messages',
    'stream',
    'max_tokens',
    'temperature',
    'stop',
    'top_p',
    'thinking',
    'tools',
    'tool_choice',
    'reasoning_effort',
    'prompt_cache_key',
    'stream_options'
]);

export function cloneOpenAIChatUpstreamRequest(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeMessageRole(message) {
    if (!message || typeof message !== 'object') return message;
    if (message.role !== 'developer') return message;
    return {...message, role: 'system'};
}

function cleanFunctionTool(tool) {
    if (!tool || typeof tool !== 'object' || tool.type !== 'function') return null;

    const source = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '';
    if (!name) return null;

    const fn = {name};
    if (source.description !== undefined) fn.description = source.description;
    if (source.parameters !== undefined) fn.parameters = source.parameters;
    return {type: 'function', function: fn};
}

function normalizeTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const functionTools = tools.map(cleanFunctionTool).filter(Boolean);
    return functionTools.length > 0 ? functionTools : undefined;
}

function normalizeToolChoice(choice) {
    if (choice === undefined) return undefined;
    if (typeof choice === 'string') {
        return ['auto', 'none', 'required'].includes(choice) ? choice : undefined;
    }
    if (!choice || typeof choice !== 'object') return undefined;
    if (choice.type === 'function') {
        const name = choice.function?.name || choice.name;
        return typeof name === 'string' && name.trim()
            ? {type: 'function', function: {name: name.trim()}}
            : undefined;
    }
    if (choice.type === 'auto') return 'auto';
    if (choice.type === 'none') return 'none';
    if (choice.type === 'required' || choice.type === 'any') return 'required';
    return undefined;
}

function applyOpenAIChatAliases(request) {
    if (request.max_tokens === undefined) {
        if (request.max_completion_tokens !== undefined) {
            request.max_tokens = request.max_completion_tokens;
        } else if (request.max_output_tokens !== undefined) {
            request.max_tokens = request.max_output_tokens;
        }
    }

    if (request.reasoning_effort === undefined && request.reasoning?.effort) {
        request.reasoning_effort = request.reasoning.effort;
    }

    if (Array.isArray(request.messages)) {
        request.messages = request.messages.map(normalizeMessageRole);
    }
}

function applyStrictChatCompatibility(request) {
    const tools = normalizeTools(request.tools);
    if (tools) {
        request.tools = tools;
        const toolChoice = normalizeToolChoice(request.tool_choice);
        if (toolChoice !== undefined) {
            request.tool_choice = toolChoice;
        } else {
            delete request.tool_choice;
        }
    } else {
        delete request.tools;
        delete request.tool_choice;
    }

    for (const key of Object.keys(request)) {
        if (!STRICT_CHAT_FIELDS.has(key)) {
            delete request[key];
        }
    }
}

export function prepareOpenAIChatUpstreamRequest(chatRequest, {
    model,
    stream,
    clone = true,
    stripUnknownFields = false
} = {}) {
    const request = clone ? cloneOpenAIChatUpstreamRequest(chatRequest || {}) : (chatRequest || {});

    if (model !== undefined) request.model = model;
    if (stream !== undefined) request.stream = stream;

    applyOpenAIChatAliases(request);
    for (const field of CHAT_CONTROL_FIELDS) {
        delete request[field];
    }
    if (stripUnknownFields) {
        applyStrictChatCompatibility(request);
    }

    return request;
}
