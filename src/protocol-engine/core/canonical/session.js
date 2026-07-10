const SCHEMA_VERSION = 1;

function createSession(request = {}, meta = {}, sourceProtocol = 'unknown') {
    return {
        schemaVersion: SCHEMA_VERSION,
        sessionId: meta.sessionId || meta.conversationKey || `canonical_${Date.now()}`,
        tenantId: meta.tenantId || null,
        conversationKey: meta.conversationKey || null,
        sourceProtocol,
        model: request.model,
        previousResponseId: request.previous_response_id || null,
        turns: [],
        toolMappings: [],
        tools: Array.isArray(request.tools) ? clone(request.tools) : [],
        toolChoice: request.tool_choice,
        parallelToolCalls: request.parallel_tool_calls
    };
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function addTurn(session, role, blocks = [], sourceProtocol = session.sourceProtocol) {
    const usefulBlocks = blocks.filter(Boolean);
    if (usefulBlocks.length === 0 && role !== 'system') return null;
    const turn = {
        turnId: `turn_${session.turns.length + 1}`,
        role,
        sourceProtocol,
        createdAt: Date.now(),
        blocks: usefulBlocks
    };
    session.turns.push(turn);
    return turn;
}

function addResponsesTurn(session, role, blocks = []) {
    const usefulBlocks = blocks.filter(Boolean);
    if (role === 'assistant' && usefulBlocks.length > 0) {
        const previous = session.turns[session.turns.length - 1];
        if (previous?.role === 'assistant') {
            previous.blocks.push(...usefulBlocks);
            return previous;
        }
    }
    return addTurn(session, role, usefulBlocks, 'responses');
}

function normalizeRole(role) {
    return role === 'developer' ? 'system' : role;
}

function textBlock(text, extra = {}) {
    if (text === undefined || text === null || text === '') return null;
    return {type: 'text', text: String(text), ...extra};
}

function reasoningBlock(text, extra = {}) {
    if (!text) return null;
    return {type: 'reasoning', text: String(text), ...extra};
}

function redactedThinkingBlock(data, extra = {}) {
    if (!data) return null;
    return {type: 'redacted_thinking', data: String(data), ...extra};
}

function definedFields(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined && fieldValue !== null && fieldValue !== '')
    );
}

// 解析 data: URL（data:[<mediatype>][;base64],<data>），用于把 data URL 还原成 Anthropic base64 source
function parseDataUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('data:')) return null;
    const commaIndex = url.indexOf(',');
    if (commaIndex < 0) return null;
    const header = url.slice(5, commaIndex);
    const data = url.slice(commaIndex + 1);
    const mediaType = header.split(';')[0] || 'image/png';
    return {mediaType, data};
}

// 把图片 URL 转成 Anthropic image source：data URL 解析为 base64 source
// （标准 Anthropic API 不接受 data: URL 作 url source），http(s) URL 保持 url 透传
function urlToAnthropicSource(url) {
    if (!url) return undefined;
    const dataUrl = parseDataUrl(url);
    if (dataUrl) {
        return definedFields({type: 'base64', media_type: dataUrl.mediaType, data: dataUrl.data});
    }
    return {type: 'url', url};
}

// canonical image block 可能以 url（含 data: URL）或裸 dataRef（base64）承载图片数据，
// 输出给 Chat/Responses 时需统一成完整可用的 URL：data URL 原样返回，裸 base64 补 data: 前缀
function canonicalImageDataURL(block = {}) {
    if (block.url) return block.url;
    if (block.dataRef) {
        return `data:${block.mediaType || 'image/png'};base64,${block.dataRef}`;
    }
    return '';
}

// 把原始（未规范化）的图片 part 转成 data URL，兼容 anthropic image / chat image_url / responses input_image
function rawImagePartToURL(part) {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'image') {
        return part.source?.data
            ? `data:${part.source.media_type};base64,${part.source.data}`
            : (part.source?.url || '');
    }
    if (part.type === 'image_url') {
        return part.image_url?.url || part.image_url || '';
    }
    if (part.type === 'input_image') {
        return part.image_url || part.url || '';
    }
    return '';
}

function isImagePart(part) {
    return part?.type === 'image' || part?.type === 'image_url' || part?.type === 'input_image';
}

// canonical tool_result.content 保留客户端原始格式（字符串或 content 数组），
// 可能内嵌 anthropic image 或 chat image_url。Responses 的 function_call_output.output
// 仅接受字符串，因此含图片时把文本合并为 output，图片提取为独立 user input item。
function canonicalToolResultToResponsesOutput(content) {
    if (typeof content === 'string') return {output: content, imageItems: []};
    if (!Array.isArray(content)) {
        return {output: content == null ? '' : JSON.stringify(content || ''), imageItems: []};
    }
    const imageItems = [];
    const textParts = [];
    for (const part of content) {
        if (typeof part === 'string') {
            textParts.push(part);
            continue;
        }
        if (!part || typeof part !== 'object') continue;
        if (isImagePart(part)) {
            const url = rawImagePartToURL(part);
            if (url) imageItems.push({type: 'input_image', image_url: url});
        } else if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            textParts.push(part.text || '');
        }
    }
    const output = imageItems.length > 0 ? textParts.join('\n').trim() : JSON.stringify(content);
    return {output, imageItems};
}

// canonical tool_result.content 渲染为 Chat tool message content：
// 字符串原样返回；纯文本数组（无图片）合并为字符串以保持标量；含图片则转成 image_url 数组
function canonicalToolResultContentToChat(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || content.length === 0) {
        return content == null ? '' : String(content);
    }
    if (!content.some(isImagePart)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .join('\n')
            .trim();
    }
    return content
        .map((part) => {
            if (typeof part === 'string') return {type: 'text', text: part};
            if (!part || typeof part !== 'object') return null;
            if (isImagePart(part)) {
                return {type: 'image_url', image_url: {url: rawImagePartToURL(part)}};
            }
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                return {type: 'text', text: part.text || ''};
            }
            return null;
        })
        .filter(Boolean);
}

// canonical tool_result.content 渲染为 Anthropic tool_result content：
// 字符串原样返回；纯文本数组（无图片）合并为字符串保持标量；含图片则转成
// Anthropic 原生 content 数组（text + image block），避免 JSON.stringify 把图片压扁。
// Anthropic tool_result.content 协议支持 image block，故可内联无需像 Responses 那样提取独立 item
function canonicalToolResultContentToAnthropic(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || content.length === 0) {
        return content == null ? '' : JSON.stringify(content || '');
    }
    if (!content.some(isImagePart)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part?.text || ''))
            .join('\n')
            .trim();
    }
    return content
        .map((part) => {
            if (typeof part === 'string') return {type: 'text', text: part};
            if (!part || typeof part !== 'object') return null;
            if (part.type === 'image' && part.source) {
                return {type: 'image', source: clone(part.source)};
            }
            if (isImagePart(part)) {
                const source = urlToAnthropicSource(rawImagePartToURL(part));
                return source ? {type: 'image', source} : null;
            }
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                return {type: 'text', text: part.text || ''};
            }
            return null;
        })
        .filter(Boolean);
}

function contentToBlocks(content, defaultTextType = 'text') {
    if (typeof content === 'string') return [textBlock(content)].filter(Boolean);
    if (!Array.isArray(content)) {
        if (content === undefined || content === null) return [];
        return [textBlock(JSON.stringify(content))].filter(Boolean);
    }

    return content.map((part) => {
        if (typeof part === 'string') return textBlock(part);
        if (!part || typeof part !== 'object') return null;
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            return textBlock(part.text || part.input_text || part.output_text || '');
        }
        if (part.type === 'redacted_thinking') {
            return redactedThinkingBlock(part.data);
        }
        if (part.type === 'image_url') {
            return {type: 'image', url: part.image_url?.url || part.image_url || ''};
        }
        if (part.type === 'image' || part.type === 'input_image') {
            return {
                type: 'image',
                mediaType: part.source?.media_type || part.media_type,
                url: part.source?.url || part.image_url || part.url,
                dataRef: part.source?.data || part.file_id
            };
        }
        if (part.type === 'file' || part.type === 'input_file') {
            const file = part.file && typeof part.file === 'object' ? part.file : {};
            const fileRef = typeof part.file === 'string' ? part.file : undefined;
            return definedFields({
                type: 'file',
                mediaType: part.media_type || file.media_type,
                filename: part.filename || file.filename,
                url: part.file_url || part.url || file.file_url || file.url,
                dataRef: part.file_data || part.file_id || file.file_data || file.file_id || fileRef
            });
        }
        if (part.text) return {type: defaultTextType, text: part.text};
        return null;
    }).filter(Boolean);
}

function relayAnthropicContentToBlocks(content, defaultTextType = 'text') {
    if (!Array.isArray(content)) return contentToBlocks(content, defaultTextType);

    return content.map((part) => {
        if (typeof part === 'string') return textBlock(part);
        if (!part || typeof part !== 'object') return null;
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
            const {
                type,
                text,
                input_text,
                output_text,
                ...anthropic
            } = part;
            return textBlock(text || input_text || output_text || '', Object.keys(anthropic).length > 0
                ? {anthropic}
                : {});
        }
        if (part.type === 'thinking') {
            return reasoningBlock(part.thinking || '', {signature: part.signature});
        }
        if (part.type === 'redacted_thinking') {
            return redactedThinkingBlock(part.data || '');
        }
        if (part.type === 'image') {
            const {
                type,
                source,
                ...anthropic
            } = part;
            return definedFields({
                type: 'image',
                mediaType: source?.media_type || part.media_type,
                url: source?.url || part.image_url || part.url,
                dataRef: source?.data || part.file_id,
                anthropicSource: source ? clone(source) : undefined,
                anthropic: Object.keys(anthropic).length > 0 ? anthropic : undefined
            });
        }
        if (part.type === 'tool_use') {
            return null;
        }
        return {type: 'anthropic_content', content: clone(part)};
    }).filter(Boolean);
}

function findToolMapping(session, ids = {}) {
    return session.toolMappings.find((mapping) =>
        (ids.canonicalToolCallId && mapping.canonicalToolCallId === ids.canonicalToolCallId) ||
        (ids.openAIChatToolCallId && mapping.openAIChatToolCallId === ids.openAIChatToolCallId) ||
        (ids.responsesCallId && mapping.responsesCallId === ids.responsesCallId) ||
        (ids.responsesItemId && mapping.responsesItemId === ids.responsesItemId) ||
        (ids.anthropicToolUseId && mapping.anthropicToolUseId === ids.anthropicToolUseId)
    );
}

function toolMappingValues(mapping = {}) {
    return [
        mapping.canonicalToolCallId,
        mapping.openAIChatToolCallId,
        mapping.responsesCallId,
        mapping.responsesItemId,
        mapping.anthropicToolUseId
    ].filter(Boolean);
}

function findCompatibleToolMapping(session, mapping) {
    const values = new Set(toolMappingValues(mapping));
    return (session.toolMappings || []).find((candidate) =>
        toolMappingValues(candidate).some((value) => values.has(value))
    );
}

function ensureToolMapping(session, ids = {}, name = '') {
    let mapping = findToolMapping(session, ids);
    if (!mapping) {
        mapping = {
            canonicalToolCallId: ids.canonicalToolCallId || `ctc_${session.toolMappings.length + 1}`,
            openAIChatToolCallId: null,
            responsesCallId: null,
            responsesItemId: null,
            anthropicToolUseId: null,
            name: name || '',
            status: 'open'
        };
        session.toolMappings.push(mapping);
    }

    for (const key of ['openAIChatToolCallId', 'responsesCallId', 'responsesItemId', 'anthropicToolUseId']) {
        if (ids[key] && !mapping[key]) mapping[key] = ids[key];
    }
    if (name && !mapping.name) mapping.name = name;
    return mapping;
}

function toolTargetId(mapping, target) {
    if (!mapping) return null;
    if (target === 'chat') {
        return mapping.openAIChatToolCallId || mapping.responsesCallId || mapping.anthropicToolUseId || mapping.canonicalToolCallId;
    }
    if (target === 'responses') {
        return mapping.responsesCallId || mapping.openAIChatToolCallId || mapping.anthropicToolUseId || mapping.canonicalToolCallId;
    }
    if (target === 'anthropic') {
        return mapping.anthropicToolUseId || mapping.openAIChatToolCallId || mapping.responsesCallId || mapping.canonicalToolCallId;
    }
    return mapping.canonicalToolCallId;
}

function parseJsonObject(text) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function toolsForChat(tools = []) {
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return null;
        if (tool.type === 'function' && tool.function) return clone(tool);
        if (tool.type === 'function' && tool.name) {
            const {type, name = '', description = '', parameters = {}, ...rest} = tool;
            return {type, function: {name, description, parameters, ...rest}};
        }
        if (tool.name && tool.input_schema) {
            const {name = '', description = '', input_schema: parameters = {}, ...rest} = tool;
            return {type: 'function', function: {name, description, parameters, ...rest}};
        }
        return null;
    }).filter(Boolean);
}

function toolsForResponses(tools = []) {
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return null;
        if (tool.type === 'function' && tool.function) {
            const {name = '', description = '', parameters = {}, ...rest} = tool.function || {};
            return {type: 'function', name, description, parameters, ...rest};
        }
        if (tool.type === 'function' && tool.name) return clone(tool);
        if (tool.name && tool.input_schema) {
            const {name = '', description = '', input_schema: parameters = {}, ...rest} = tool;
            return {type: 'function', name, description, parameters, ...rest};
        }
        return clone(tool);
    }).filter(Boolean);
}

function toolsForAnthropic(tools = []) {
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => {
        if (!tool || typeof tool !== 'object') return null;
        if (tool.type === 'function' && tool.function) {
            const {name = '', description = '', parameters: input_schema = {}, ...rest} = tool.function || {};
            return name ? {name, description, input_schema, ...rest} : null;
        }
        if (tool.type === 'function' && tool.name) {
            const {type, name = '', description = '', parameters: input_schema = {}, ...rest} = tool;
            return name ? {name, description, input_schema, ...rest} : null;
        }
        if (tool.name && tool.input_schema) return clone(tool);
        return null;
    }).filter(Boolean);
}

function toolChoiceForChat(choice) {
    if (!choice || typeof choice === 'string') return choice;
    if (choice.type === 'function' && choice.function?.name) return clone(choice);
    if (choice.type === 'function' && choice.name) return {type: 'function', function: {name: choice.name}};
    if (choice.type === 'tool' && choice.name) return {type: 'function', function: {name: choice.name}};
    if (choice.type === 'any') return 'required';
    if (choice.type === 'auto' || choice.type === 'none') return choice.type;
    return clone(choice);
}

function toolChoiceForResponses(choice) {
    if (!choice || typeof choice === 'string') return choice;
    if (choice.type === 'function' && choice.function?.name) return {type: 'function', name: choice.function.name};
    if (choice.type === 'function' && choice.name) return clone(choice);
    if (choice.type === 'tool' && choice.name) return {type: 'function', name: choice.name};
    if (choice.type === 'any') return 'required';
    if (choice.type === 'auto' || choice.type === 'none') return choice.type;
    return clone(choice);
}

function toolChoiceForAnthropic(choice) {
    if (!choice) return choice;
    if (typeof choice === 'string') {
        if (choice === 'required') return {type: 'any'};
        if (choice === 'auto' || choice === 'none') return {type: choice};
        return choice;
    }
    if (choice.type === 'function' && choice.function?.name) return {type: 'tool', name: choice.function.name};
    if (choice.type === 'function' && choice.name) return {type: 'tool', name: choice.name};
    if (choice.type === 'tool' || choice.type === 'any' || choice.type === 'auto' || choice.type === 'none') return clone(choice);
    return clone(choice);
}

export function preserveCanonicalToolMappings(session = {}, previousSession = {}) {
    if (!Array.isArray(session.toolMappings)) session.toolMappings = [];
    const previousMappings = Array.isArray(previousSession?.toolMappings) ? previousSession.toolMappings : [];

    for (const previous of previousMappings) {
        const target = findCompatibleToolMapping(session, previous);
        if (!target) {
            session.toolMappings.push(clone(previous));
            continue;
        }

        for (const key of ['openAIChatToolCallId', 'responsesCallId', 'responsesItemId', 'anthropicToolUseId']) {
            if (!target[key] && previous[key]) target[key] = previous[key];
        }
        if (!target.name && previous.name) target.name = previous.name;
        if (target.status === 'open' && previous.status && previous.status !== 'open') target.status = previous.status;
    }

    return session;
}

export function preserveCanonicalResponseToolMappings(session = {}, previousSession = {}) {
    preserveCanonicalToolMappings(session, previousSession);

    const targetCalls = lastToolCallBlocks(session);
    const previousCalls = lastToolCallBlocks(previousSession);
    const count = Math.min(targetCalls.length, previousCalls.length);
    for (let index = 0; index < count; index++) {
        const targetBlock = targetCalls[index];
        const previousBlock = previousCalls[index];
        if (targetBlock.name && previousBlock.name && targetBlock.name !== previousBlock.name) continue;

        const target = findToolMapping(session, {canonicalToolCallId: targetBlock.canonicalToolCallId});
        const previous = findToolMapping(previousSession, {canonicalToolCallId: previousBlock.canonicalToolCallId});
        if (!target || !previous) continue;
        for (const key of ['openAIChatToolCallId', 'responsesCallId', 'responsesItemId', 'anthropicToolUseId']) {
            if (!target[key] && previous[key]) target[key] = previous[key];
        }
        if (!target.name && previous.name) target.name = previous.name;
    }

    return session;
}

function lastToolCallBlocks(session = {}) {
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    for (let index = turns.length - 1; index >= 0; index--) {
        const blocks = Array.isArray(turns[index]?.blocks) ? turns[index].blocks : [];
        const toolCalls = blocks.filter((block) => block?.type === 'tool_call');
        if (toolCalls.length > 0) return toolCalls;
    }
    return [];
}

export function canonicalFromAnthropicResponse(anthropicResponse = {}, meta = {}) {
    return appendAnthropicResponseToCanonical(
        createSession({model: anthropicResponse?.model}, meta, 'anthropic'),
        anthropicResponse
    );
}

export function canonicalFromResponsesResponse(responsesResponse = {}, meta = {}) {
    return appendResponsesResponseToCanonical(
        createSession({model: responsesResponse?.model}, meta, 'responses'),
        responsesResponse
    );
}

export function canonicalFromAnthropicStreamChatResponse(chatResponse = {}, meta = {}) {
    const session = createSession({model: chatResponse?.model}, meta, 'anthropic');
    const message = chatResponse?.choices?.[0]?.message;
    if (!message) return session;

    const blocks = [];
    blocks.push(reasoningBlock(message.reasoning_content || message.reasoning));
    blocks.push(...contentToBlocks(message.content));
    if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            const mapping = ensureToolMapping(
                session,
                {anthropicToolUseId: toolCall.id},
                toolCall.function?.name || ''
            );
            blocks.push({
                type: 'tool_call',
                canonicalToolCallId: mapping.canonicalToolCallId,
                name: toolCall.function?.name || '',
                argumentsText: toolCall.function?.arguments || '{}',
                status: 'completed'
            });
        }
    }
    addTurn(session, 'assistant', blocks, 'anthropic');
    return session;
}

export function canonicalFromChatRequest(chatReq = {}, meta = {}) {
    const session = createSession(chatReq, meta, 'chat');
    for (const message of chatReq.messages || []) {
        if (!message || typeof message !== 'object') continue;
        const role = normalizeRole(message.role);

        if (role === 'tool') {
            const mapping = ensureToolMapping(session, {openAIChatToolCallId: message.tool_call_id});
            mapping.status = 'result_received';
            addTurn(session, 'tool', [{
                type: 'tool_result',
                canonicalToolCallId: mapping.canonicalToolCallId,
                content: message.content
            }]);
            continue;
        }

        const blocks = [];
        if (role === 'assistant') {
            blocks.push(reasoningBlock(message.reasoning_content || message.reasoning));
        }
        blocks.push(...contentToBlocks(message.content));
        if (role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                const mapping = ensureToolMapping(
                    session,
                    {openAIChatToolCallId: toolCall.id},
                    toolCall.function?.name || ''
                );
                blocks.push({
                    type: 'tool_call',
                    canonicalToolCallId: mapping.canonicalToolCallId,
                    name: toolCall.function?.name || '',
                    argumentsText: toolCall.function?.arguments || '{}',
                    status: 'completed'
                });
            }
        }
        addTurn(session, role, blocks);
    }
    return session;
}

export function canonicalFromResponsesRequest(responsesReq = {}, meta = {}) {
    const session = createSession(responsesReq, meta, 'responses');
    if (responsesReq.instructions) {
        addTurn(session, 'system', [textBlock(responsesReq.instructions)]);
    }

    const input = responsesReq.input;
    if (typeof input === 'string') {
        addTurn(session, 'user', [textBlock(input)]);
    } else if (Array.isArray(input)) {
        for (const item of input) {
            if (!item || typeof item !== 'object') continue;
            if (item.role) {
                const blocks = Array.isArray(item.x_relay_anthropic_content)
                    ? relayAnthropicContentToBlocks(item.x_relay_anthropic_content)
                    : contentToBlocks(item.content);
                addResponsesTurn(session, normalizeRole(item.role), blocks);
                continue;
            }
            if (item.type === 'reasoning') {
                const blocks = responsesReasoningItemToBlocks(item);
                addResponsesTurn(session, 'assistant', blocks);
                continue;
            }
            if (item.type === 'function_call') {
                const mapping = ensureToolMapping(
                    session,
                    {responsesCallId: item.call_id, responsesItemId: item.id},
                    item.name || ''
                );
                addResponsesTurn(session, 'assistant', [{
                    type: 'tool_call',
                    canonicalToolCallId: mapping.canonicalToolCallId,
                    name: item.name || '',
                    argumentsText: item.arguments || '{}',
                    status: item.status || 'completed'
                }]);
                continue;
            }
            if (item.type === 'function_call_output') {
                const mapping = ensureToolMapping(session, {responsesCallId: item.call_id});
                const relayToolResult = relayAnthropicToolResult(item.x_relay_anthropic_tool_result);
                mapping.status = 'result_received';
                addResponsesTurn(session, 'tool', [{
                    type: 'tool_result',
                    canonicalToolCallId: mapping.canonicalToolCallId,
                    content: relayToolResult?.content ?? item.output,
                    ...(relayToolResult?.isError ? {isError: true} : {}),
                    ...(relayToolResult?.anthropicContent !== undefined ? {anthropicContent: relayToolResult.anthropicContent} : {}),
                    ...(relayToolResult?.anthropic ? {anthropic: relayToolResult.anthropic} : {})
                }]);
                continue;
            }
            if (item.type === 'input_text' || item.type === 'output_text') {
                addResponsesTurn(session, item.type === 'output_text' ? 'assistant' : 'user', [textBlock(item.text || '')]);
            }
        }
    }
    return session;
}

function responsesReasoningItemToBlocks(item = {}) {
    if (Array.isArray(item.x_relay_anthropic_thinking) && item.x_relay_anthropic_thinking.length > 0) {
        return item.x_relay_anthropic_thinking
            .map((block) => {
                if (block?.type === 'thinking') {
                    return reasoningBlock(block.thinking || '', {
                        responsesItemId: item.id,
                        signature: block.signature
                    });
                }
                if (block?.type === 'redacted_thinking') {
                    return redactedThinkingBlock(block.data || '', {responsesItemId: item.id});
                }
                return null;
            })
            .filter(Boolean);
    }

    const text = Array.isArray(item.summary)
        ? item.summary.map((part) => part.text || '').filter(Boolean).join('\n')
        : '';
    return [reasoningBlock(text, {responsesItemId: item.id})].filter(Boolean);
}

function relayAnthropicToolResult(block) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_result') return null;
    const {
        type,
        tool_use_id,
        content,
        is_error,
        ...anthropic
    } = clone(block);
    return {
        content,
        isError: Boolean(is_error),
        ...(content !== undefined ? {anthropicContent: content} : {}),
        ...(Object.keys(anthropic).length > 0 ? {anthropic} : {})
    };
}

export function canonicalFromAnthropicRequest(anthropicReq = {}, meta = {}) {
    const session = createSession(anthropicReq, meta, 'anthropic');
    if (anthropicReq.system) {
        const systemBlocks = typeof anthropicReq.system === 'string'
            ? [textBlock(anthropicReq.system)]
            : contentToBlocks(anthropicReq.system);
        addTurn(session, 'system', systemBlocks);
    }

    for (const message of anthropicReq.messages || []) {
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'user' && Array.isArray(message.content)) {
            const userBlocks = [];
            for (const block of message.content) {
                if (block?.type === 'tool_result') {
                    const mapping = ensureToolMapping(session, {anthropicToolUseId: block.tool_use_id});
                    mapping.status = 'result_received';
                    addTurn(session, 'tool', [{
                        type: 'tool_result',
                        canonicalToolCallId: mapping.canonicalToolCallId,
                        content: block.content,
                        isError: block.is_error || block.error || false,
                        ...(block.content !== undefined ? {anthropicContent: clone(block.content)} : {}),
                        ...anthropicToolResultExtra(block)
                    }]);
                } else {
                    userBlocks.push(...contentToBlocks([block]));
                }
            }
            addTurn(session, 'user', userBlocks);
            continue;
        }

        if (message.role === 'assistant' && Array.isArray(message.content)) {
            const blocks = [];
            for (const block of message.content) {
                if (block?.type === 'thinking') {
                    blocks.push(reasoningBlock(block.thinking || '', {signature: block.signature}));
                } else if (block?.type === 'tool_use') {
                    const mapping = ensureToolMapping(
                        session,
                        {anthropicToolUseId: block.id},
                        block.name || ''
                    );
                    blocks.push({
                        type: 'tool_call',
                        canonicalToolCallId: mapping.canonicalToolCallId,
                        name: block.name || '',
                        argumentsText: JSON.stringify(block.input || {}),
                        status: 'completed'
                    });
                } else {
                    blocks.push(...contentToBlocks([block]));
                }
            }
            addTurn(session, 'assistant', blocks);
            continue;
        }

        addTurn(session, normalizeRole(message.role), contentToBlocks(message.content));
    }
    return session;
}

function anthropicToolResultExtra(block) {
    const {
        type,
        tool_use_id,
        content,
        is_error,
        error,
        ...anthropic
    } = block || {};
    return Object.keys(anthropic).length > 0 ? {anthropic: clone(anthropic)} : {};
}

export function appendChatResponseToCanonical(session = {}, chatResponse = {}) {
    const next = clone(session) || createSession({model: chatResponse?.model}, {}, 'chat');
    const message = chatResponse?.choices?.[0]?.message;
    if (!message) return next;

    const blocks = [];
    blocks.push(reasoningBlock(message.reasoning_content || message.reasoning));
    blocks.push(...contentToBlocks(message.content));
    if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            const mapping = ensureToolMapping(
                next,
                {openAIChatToolCallId: toolCall.id},
                toolCall.function?.name || ''
            );
            blocks.push({
                type: 'tool_call',
                canonicalToolCallId: mapping.canonicalToolCallId,
                name: toolCall.function?.name || '',
                argumentsText: toolCall.function?.arguments || '{}',
                status: 'completed'
            });
        }
    }
    addTurn(next, 'assistant', blocks, 'chat');
    return next;
}

export function appendResponsesResponseToCanonical(session = {}, responsesResponse = {}) {
    const next = clone(session) || createSession({model: responsesResponse?.model}, {}, 'responses');
    if (!next.model && responsesResponse?.model) next.model = responsesResponse.model;

    const blocks = [];
    for (const item of responsesResponse.output || []) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'reasoning') {
            blocks.push(...responsesReasoningItemToBlocks(item));
        } else if (item.type === 'message') {
            blocks.push(...contentToBlocks(item.content));
        } else if (item.type === 'function_call') {
            const mapping = ensureToolMapping(
                next,
                {responsesCallId: item.call_id, responsesItemId: item.id},
                item.name || ''
            );
            blocks.push({
                type: 'tool_call',
                canonicalToolCallId: mapping.canonicalToolCallId,
                name: item.name || '',
                argumentsText: item.arguments || '{}',
                status: item.status || 'completed'
            });
        }
    }

    addTurn(next, 'assistant', blocks, 'responses');
    return next;
}

export function appendAnthropicResponseToCanonical(session = {}, anthropicResponse = {}) {
    const next = clone(session) || createSession({model: anthropicResponse?.model}, {}, 'anthropic');
    if (!next.model && anthropicResponse?.model) next.model = anthropicResponse.model;

    const blocks = [];
    for (const block of anthropicResponse.content || []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'thinking') {
            blocks.push(reasoningBlock(block.thinking || '', {signature: block.signature}));
        } else if (block.type === 'tool_use') {
            const mapping = ensureToolMapping(
                next,
                {anthropicToolUseId: block.id},
                block.name || ''
            );
            blocks.push({
                type: 'tool_call',
                canonicalToolCallId: mapping.canonicalToolCallId,
                name: block.name || '',
                argumentsText: JSON.stringify(block.input || {}),
                status: 'completed'
            });
        } else {
            blocks.push(...contentToBlocks([block]));
        }
    }

    addTurn(next, 'assistant', blocks, 'anthropic');
    return next;
}

function blocksToText(blocks) {
    return blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .filter(Boolean)
        .join('\n\n');
}

function blocksToChatContent(blocks) {
    const contentBlocks = blocks.filter((block) => block.type === 'text' || block.type === 'image' || block.type === 'file');
    if (contentBlocks.length === 0) return null;
    if (contentBlocks.every((block) => block.type === 'text')) return blocksToText(contentBlocks);
    return contentBlocks.map((block) => {
        if (block.type === 'text') return {type: 'text', text: block.text || ''};
        if (block.type === 'image') return {type: 'image_url', image_url: {url: canonicalImageDataURL(block)}};
        return {type: 'file', file: block.url || block.dataRef || block.filename || ''};
    });
}

export function renderCanonicalToChat(session = {}) {
    const messages = [];
    for (const turn of session.turns || []) {
        if (turn.role === 'tool') {
            for (const block of turn.blocks || []) {
                if (block.type !== 'tool_result') continue;
                const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
                messages.push({
                    role: 'tool',
                    tool_call_id: toolTargetId(mapping, 'chat'),
                    content: canonicalToolResultContentToChat(block.content)
                });
            }
            continue;
        }

        const message = {role: turn.role, content: blocksToChatContent(turn.blocks || [])};
        if (turn.role === 'assistant') {
            const reasoning = (turn.blocks || []).filter((block) => block.type === 'reasoning').map((block) => block.text).filter(Boolean).join('\n');
            if (reasoning) message.reasoning_content = reasoning;
            const toolCalls = (turn.blocks || []).filter((block) => block.type === 'tool_call').map((block) => {
                const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
                return {
                    id: toolTargetId(mapping, 'chat'),
                    type: 'function',
                    function: {
                        name: block.name || mapping?.name || '',
                        arguments: block.argumentsText || '{}'
                    }
                };
            });
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
                if (message.content == null) message.content = '';
            }
        }
        messages.push(message);
    }

    return {
        model: session.model,
        messages,
        tools: toolsForChat(session.tools),
        tool_choice: toolChoiceForChat(session.toolChoice),
        parallel_tool_calls: session.parallelToolCalls
    };
}

function blocksToResponsesContent(blocks, textType) {
    return blocks
        .filter((block) => block.type === 'text' || block.type === 'image' || block.type === 'file')
        .map((block) => {
            if (block.type === 'text') return {type: textType, text: block.text || ''};
            if (block.type === 'image') return {type: 'input_image', image_url: canonicalImageDataURL(block)};
            return {type: 'input_file', file_data: block.dataRef || block.url || ''};
        });
}

export function renderCanonicalToResponses(session = {}) {
    const input = [];
    const instructions = [];

    for (const turn of session.turns || []) {
        if (turn.role === 'system') {
            const text = blocksToText(turn.blocks || []);
            if (text) instructions.push(text);
            continue;
        }

        for (const block of turn.blocks || []) {
            if (block.type === 'reasoning') {
                input.push({
                    type: 'reasoning',
                    ...(block.responsesItemId ? {id: block.responsesItemId} : {}),
                    summary: [{type: 'summary_text', text: block.text || ''}],
                    ...(block.signature ? {
                        x_relay_anthropic_thinking: [{
                            type: 'thinking',
                            thinking: block.text || '',
                            signature: block.signature
                        }]
                    } : {})
                });
            } else if (block.type === 'redacted_thinking') {
                input.push({
                    type: 'reasoning',
                    summary: [],
                    x_relay_anthropic_thinking: [{
                        type: 'redacted_thinking',
                        data: block.data || ''
                    }]
                });
            }
        }

        const content = blocksToResponsesContent(turn.blocks || [], turn.role === 'assistant' ? 'output_text' : 'input_text');
        if (content.length > 0 && turn.role !== 'tool') {
            input.push({role: turn.role, content});
        }

        for (const block of turn.blocks || []) {
            if (block.type === 'tool_call') {
                const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
                input.push({
                    type: 'function_call',
                    ...(mapping?.responsesItemId ? {id: mapping.responsesItemId} : {}),
                    call_id: toolTargetId(mapping, 'responses'),
                    name: block.name || mapping?.name || '',
                    arguments: block.argumentsText || '{}'
                });
            } else if (block.type === 'tool_result') {
                const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
                const {output, imageItems} = canonicalToolResultToResponsesOutput(block.content);
                input.push({
                    type: 'function_call_output',
                    call_id: toolTargetId(mapping, 'responses'),
                    output
                });
                if (imageItems.length > 0) {
                    input.push({role: 'user', content: imageItems});
                }
            }
        }
    }

    return {
        model: session.model,
        input,
        ...(instructions.length > 0 ? {instructions: instructions.join('\n\n')} : {}),
        ...(session.previousResponseId ? {previous_response_id: session.previousResponseId} : {}),
        tools: toolsForResponses(session.tools),
        tool_choice: toolChoiceForResponses(session.toolChoice),
        parallel_tool_calls: session.parallelToolCalls
    };
}

function blocksToAnthropicContent(blocks) {
    const content = [];
    for (const block of blocks || []) {
        if (block.type === 'reasoning') {
            if (block.signature) {
                content.push({type: 'thinking', thinking: block.text || '', signature: block.signature});
            }
        } else if (block.type === 'redacted_thinking') {
            content.push({type: 'redacted_thinking', data: block.data || ''});
        } else if (block.type === 'text') {
            content.push({type: 'text', text: block.text || '', ...(block.anthropic ? clone(block.anthropic) : {})});
        } else if (block.type === 'image') {
            const source = block.anthropicSource
                ? clone(block.anthropicSource)
                : block.url
                    ? urlToAnthropicSource(block.url)
                    : definedFields({type: 'base64', media_type: block.mediaType, data: block.dataRef || ''});
            if (source) content.push({type: 'image', source, ...(block.anthropic ? clone(block.anthropic) : {})});
        } else if (block.type === 'file') {
            content.push({type: 'text', text: block.url || block.filename || block.dataRef || ''});
        } else if (block.type === 'anthropic_content') {
            content.push(clone(block.content));
        } else if (block.type === 'tool_call') {
            content.push({type: 'tool_use', id: block.canonicalToolCallId, name: block.name || '', input: parseJsonObject(block.argumentsText)});
        }
    }
    return content;
}

export function renderCanonicalToAnthropic(session = {}) {
    const messages = [];
    const systemParts = [];
    let pendingToolResults = [];
    let lastAssistantToolUseOrder = [];

    const flushToolResults = () => {
        if (pendingToolResults.length === 0) return;
        messages.push({
            role: 'user',
            content: orderAnthropicToolResults(pendingToolResults, lastAssistantToolUseOrder)
        });
        pendingToolResults = [];
    };

    for (const turn of session.turns || []) {
        if (turn.role === 'system') {
            const text = blocksToText(turn.blocks || []);
            if (text) systemParts.push(text);
            continue;
        }

        if (turn.role === 'tool') {
            for (const block of turn.blocks || []) {
                const rendered = block.type === 'tool_result'
                    ? anthropicToolResultBlock(session, block)
                    : null;
                if (rendered) pendingToolResults.push(rendered);
            }
            continue;
        }

        flushToolResults();
        const content = [];
        for (const block of turn.blocks || []) {
            if (block.type === 'tool_call') {
                const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
                content.push({
                    type: 'tool_use',
                    id: toolTargetId(mapping, 'anthropic'),
                    name: block.name || mapping?.name || '',
                    input: parseJsonObject(block.argumentsText)
                });
            } else {
                content.push(...blocksToAnthropicContent([block]));
            }
        }
        messages.push({role: turn.role, content: content.length > 0 ? content : [{type: 'text', text: ''}]});
        lastAssistantToolUseOrder = turn.role === 'assistant'
            ? content.filter((block) => block.type === 'tool_use').map((block) => block.id)
            : [];
    }

    flushToolResults();
    return {
        model: session.model,
        ...(systemParts.length > 0 ? {system: systemParts.join('\n\n')} : {}),
        messages,
        tools: toolsForAnthropic(session.tools),
        tool_choice: toolChoiceForAnthropic(session.toolChoice)
    };
}

function orderAnthropicToolResults(results, toolUseOrder = []) {
    if (!Array.isArray(results) || results.length <= 1 || !Array.isArray(toolUseOrder) || toolUseOrder.length === 0) {
        return results;
    }
    const order = new Map();
    toolUseOrder.forEach((id, index) => {
        if (id && !order.has(id)) order.set(id, index);
    });
    return results
        .map((block, index) => ({
            block,
            index,
            order: order.has(block.tool_use_id) ? order.get(block.tool_use_id) : Number.MAX_SAFE_INTEGER
        }))
        .sort((left, right) => left.order - right.order || left.index - right.index)
        .map(({block}) => block);
}

function anthropicToolResultBlock(session, block) {
    const mapping = findToolMapping(session, {canonicalToolCallId: block.canonicalToolCallId});
    return {
        type: 'tool_result',
        tool_use_id: toolTargetId(mapping, 'anthropic'),
        // anthropicContent（Anthropic 原生/中继来源）直接保留；否则把 content 渲染成
        // Anthropic 原生格式——含图片时输出 text+image block 数组，而非 JSON.stringify 压扁
        content: block.anthropicContent !== undefined
            ? clone(block.anthropicContent)
            : canonicalToolResultContentToAnthropic(block.content),
        ...(block.isError ? {is_error: true} : {}),
        ...(block.anthropic ? clone(block.anthropic) : {})
    };
}
