import {
    appendAnthropicResponseToCanonical,
    appendChatResponseToCanonical,
    appendResponsesResponseToCanonical,
    canonicalFromChatRequest,
    canonicalFromResponsesResponse,
    canonicalFromResponsesRequest,
    preserveCanonicalResponseToolMappings,
    preserveCanonicalToolMappings,
    convertResponsesUsageToChat,
    renderCanonicalToChat
} from './protocol-adapter.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STORED_CHAT_MESSAGES = 200;
const DEFAULT_MAX_CANONICAL_TURNS = 200;
const DEFAULT_TTL_MS = readPositiveIntegerEnv('RELAY_CONVERSATION_STATE_TTL_MS', DAY_MS);
const DEFAULT_CLEANUP_INTERVAL_MS = readPositiveIntegerEnv(
    'RELAY_CONVERSATION_STATE_CLEANUP_INTERVAL_MS',
    Math.min(DEFAULT_TTL_MS, FIVE_MINUTES_MS)
);

export class RelayStateMissingError extends Error {
    constructor(previousResponseId) {
        super(`Missing relay conversation state for previous_response_id=${previousResponseId}`);
        this.name = 'RelayStateMissingError';
        this.code = 'state_missing';
        this.previousResponseId = previousResponseId;
    }
}

export class RelayConversationStore {
    constructor({
        ttlMs = DEFAULT_TTL_MS,
        cleanupIntervalMs,
        now = () => Date.now(),
        maxStoredChatMessages = readPositiveIntegerEnv(
            'RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES',
            DEFAULT_MAX_STORED_CHAT_MESSAGES
        ),
        maxCanonicalTurns = readPositiveIntegerEnv(
            'RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS',
            DEFAULT_MAX_CANONICAL_TURNS
        )
    } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.maxStoredChatMessages = Number.isFinite(maxStoredChatMessages) && maxStoredChatMessages > 0
            ? Math.floor(maxStoredChatMessages)
            : 0;
        this.maxCanonicalTurns = Number.isFinite(maxCanonicalTurns) && maxCanonicalTurns > 0
            ? Math.floor(maxCanonicalTurns)
            : 0;
        this.conversations = new Map();
        this.responseIndex = new Map();
        this.cleanupTimer = null;

        cleanupIntervalMs = cleanupIntervalMs ?? Math.min(ttlMs, DEFAULT_CLEANUP_INTERVAL_MS);
        if (cleanupIntervalMs > 0) {
            this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupIntervalMs);
            this.cleanupTimer.unref?.();
        }
    }

    saveChatRequest({tenantId, conversationKey, request, canonicalSession, canonicalMappingSession}) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key || !request) return null;

        const existing = this._getByConversationKey(tenantId, conversationKey);
        const chatRequest = limitStoredChatRequest(request, this.maxStoredChatMessages);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: chatRequest.request,
            chatRequestTruncated: chatRequest.truncated,
            chatRequestMessageCount: chatRequest.messageCount,
            ...storedCanonicalSessionFields(canonicalSessionForSave({
                request,
                tenantId,
                conversationKey,
                existing,
                sourceCanonicalSession: canonicalSession,
                mappingCanonicalSession: canonicalMappingSession
            }), this.maxCanonicalTurns),
            responses: new Set(existing?.responses || []),
            lastResponseId: existing?.lastResponseId || null,
            updatedAt: this.now()
        };
        this.conversations.set(key, state);
        return cloneState(state);
    }

    hydrateResponsesForFullHistory({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        let state = null;

        if (previousResponseId) {
            state = this._getByResponseId(tenantId, previousResponseId);
            if (!state) throw new RelayStateMissingError(previousResponseId);
        } else {
            state = this._getByConversationKey(tenantId, conversationKey);
        }

        const visibleChat = responsesRequestToRelayChat(request || {}, {tenantId, conversationKey});
        const base = chatRequestFromState(state, {model: request?.model, messages: []});
        const chatRequest = mergeChatRequests(base, visibleChat, request);
        const resolvedConversationKey = state?.conversationKey || conversationKey;

        if (resolvedConversationKey) {
            this.saveChatRequest({
                tenantId,
                conversationKey: resolvedConversationKey,
                request: chatRequest,
                canonicalMappingSession: canonicalFromResponsesRequest(request || {}, {
                    tenantId,
                    conversationKey: resolvedConversationKey
                })
            });
        }

        return {conversationKey: resolvedConversationKey, chatRequest};
    }

    prepareResponsesPassthrough({tenantId, conversationKey, request}) {
        const previousResponseId = normalizeId(request?.previous_response_id);
        const state = previousResponseId
            ? this._getByResponseId(tenantId, previousResponseId) || this._getByConversationKey(tenantId, conversationKey)
            : this._getByConversationKey(tenantId, conversationKey);
        const resolvedConversationKey = state?.conversationKey || conversationKey;
        if (resolvedConversationKey) {
            const visibleChat = responsesRequestToRelayChat(request || {}, {tenantId, conversationKey: resolvedConversationKey});
            const base = chatRequestFromState(state, {model: request?.model, messages: []});
            const chatRequest = mergeChatRequests(base, visibleChat, request);
            this.saveChatRequest({
                tenantId,
                conversationKey: resolvedConversationKey,
                request: chatRequest,
                canonicalMappingSession: canonicalFromResponsesRequest(request || {}, {
                    tenantId,
                    conversationKey: resolvedConversationKey
                })
            });
        }
        return {
            conversationKey: resolvedConversationKey,
            request: {...request},
            lastResponseId: getLatestResponseId(state)
        };
    }

    recordResponsesResponse({tenantId, conversationKey, response, sourceCanonicalSession}) {
        if (!response || !conversationKey) return null;

        const key = this._conversationKey(tenantId, conversationKey);
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const chatResponse = responsesResponseToRelayChat(response);
        const nextRequest = appendAssistantFromChatResponse(
            chatRequestFromState(existing, {model: response?.model, messages: []}),
            chatResponse
        );
        const baseCanonical = existing?.canonicalSession
            || canonicalFromChatRequest(existing?.chatRequest || {model: response?.model, messages: []}, {tenantId, conversationKey});
        const canonicalSession = sourceCanonicalSession
            ? preserveCanonicalResponseToolMappings(
                appendResponsesResponseToCanonical(baseCanonical, response),
                sourceCanonicalSession
            )
            : appendResponsesResponseToCanonical(baseCanonical, response);
        const state = {
            tenantId,
            conversationKey,
            ...storedChatRequestFields(nextRequest, this.maxStoredChatMessages),
            ...storedCanonicalSessionFields(canonicalSession, this.maxCanonicalTurns),
            responses: new Set(existing?.responses || []),
            lastResponseId: existing?.lastResponseId || null,
            updatedAt: this.now()
        };

        if (response.id) {
            state.responses.add(response.id);
            state.lastResponseId = response.id;
            this.responseIndex.set(this._responseKey(tenantId, response.id), key);
        }

        this.conversations.set(key, state);
        return cloneState(state);
    }

    recordChatResponse({tenantId, conversationKey, response, sourceCanonicalSession}) {
        if (!response || !conversationKey) return null;
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const nextRequest = appendAssistantFromChatResponse(
            chatRequestFromState(existing, {model: response?.model, messages: []}),
            response
        );
        const key = this._conversationKey(tenantId, conversationKey);
        const baseCanonical = existing?.canonicalSession
            || canonicalFromChatRequest(existing?.chatRequest || {model: response?.model, messages: []}, {tenantId, conversationKey});
        const canonicalSession = sourceCanonicalSession
            ? preserveCanonicalResponseToolMappings(
                appendChatResponseToCanonical(baseCanonical, response),
                sourceCanonicalSession
            )
            : appendChatResponseToCanonical(baseCanonical, response);
        const state = {
            tenantId,
            conversationKey,
            ...storedChatRequestFields(nextRequest, this.maxStoredChatMessages),
            ...storedCanonicalSessionFields(canonicalSession, this.maxCanonicalTurns),
            responses: new Set(existing?.responses || []),
            lastResponseId: existing?.lastResponseId || null,
            updatedAt: this.now()
        };
        this.conversations.set(key, state);
        return cloneState(state);
    }

    recordAnthropicResponse({tenantId, conversationKey, response, chatResponse}) {
        if (!response || !conversationKey) return null;
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const baseRequest = chatRequestFromState(existing, {model: response?.model, messages: []});
        const nextRequest = chatResponse
            ? appendAssistantFromChatResponse(baseRequest, chatResponse)
            : baseRequest;
        const key = this._conversationKey(tenantId, conversationKey);
        const baseCanonical = existing?.canonicalSession
            || canonicalFromChatRequest(existing?.chatRequest || {model: response?.model, messages: []}, {tenantId, conversationKey});
        const state = {
            tenantId,
            conversationKey,
            ...storedChatRequestFields(nextRequest, this.maxStoredChatMessages),
            ...storedCanonicalSessionFields(
                appendAnthropicResponseToCanonical(baseCanonical, response),
                this.maxCanonicalTurns
            ),
            responses: new Set(existing?.responses || []),
            lastResponseId: existing?.lastResponseId || null,
            updatedAt: this.now()
        };
        this.conversations.set(key, state);
        return cloneState(state);
    }

    cleanupExpired() {
        let removed = 0;
        for (const [key, state] of [...this.conversations.entries()]) {
            if (this._isExpired(state)) {
                this._deleteState(key, state);
                removed++;
            }
        }

        for (const [responseKey, stateKey] of [...this.responseIndex.entries()]) {
            if (!this.conversations.has(stateKey)) {
                this.responseIndex.delete(responseKey);
            }
        }
        return removed;
    }

    dispose() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    _getByConversationKey(tenantId, conversationKey) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key) return null;

        const state = this.conversations.get(key);
        if (!state) return null;

        if (this._isExpired(state)) {
            this._deleteState(key, state);
            return null;
        }

        return state;
    }

    _getByResponseId(tenantId, responseId) {
        const responseKey = this._responseKey(tenantId, responseId);
        const stateKey = this.responseIndex.get(responseKey);
        if (!stateKey) return null;

        const state = this.conversations.get(stateKey);
        if (!state) {
            this.responseIndex.delete(responseKey);
            return null;
        }

        if (this._isExpired(state)) {
            this._deleteState(stateKey, state);
            return null;
        }

        return state;
    }

    _isExpired(state) {
        return this.now() - state.updatedAt > this.ttlMs;
    }

    _deleteState(key, state = this.conversations.get(key)) {
        this.conversations.delete(key);
        if (state?.responses) {
            for (const responseId of state.responses) {
                this.responseIndex.delete(this._responseKey(state.tenantId, responseId));
            }
            return;
        }

        for (const [responseKey, stateKey] of [...this.responseIndex.entries()]) {
            if (stateKey === key) this.responseIndex.delete(responseKey);
        }
    }

    _conversationKey(tenantId, conversationKey) {
        if (!tenantId || !conversationKey) return null;
        return `${tenantId}:${conversationKey}`;
    }

    _responseKey(tenantId, responseId) {
        return `${tenantId}:${responseId}`;
    }
}

export const relayConversationStore = new RelayConversationStore();

function readPositiveIntegerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getLatestResponseId(state) {
    return state?.lastResponseId || null;
}

function responsesRequestToRelayChat(request = {}, meta = {}) {
    const rendered = renderCanonicalToChat(canonicalFromResponsesRequest(request, meta));
    const chatReq = {
        model: rendered.model,
        messages: rendered.messages,
        stream: request.stream,
        temperature: request.temperature,
        top_p: request.top_p
    };

    if (request.max_output_tokens !== undefined) chatReq.max_tokens = request.max_output_tokens;
    if (request.reasoning?.effort) chatReq.reasoning_effort = request.reasoning.effort;
    if (Array.isArray(rendered.tools) && rendered.tools.length > 0) {
        chatReq.tools = rendered.tools;
        if (rendered.tool_choice !== undefined) chatReq.tool_choice = rendered.tool_choice;
        if (rendered.parallel_tool_calls !== undefined) chatReq.parallel_tool_calls = rendered.parallel_tool_calls;
    }
    if (request.previous_response_id) chatReq.previous_response_id = request.previous_response_id;
    if (request.store !== undefined) chatReq.store = request.store;

    return chatReq;
}

function responsesResponseToRelayChat(response = {}) {
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

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cloneChatRequest(request) {
    return clone(request) || {messages: []};
}

function hasMessages(request) {
    return Array.isArray(request?.messages) && request.messages.length > 0;
}

function chatRequestFromState(state, fallback) {
    if (state?.chatRequestTruncated && state?.canonicalSession) {
        const rendered = renderCanonicalToChat(state.canonicalSession);
        if (hasMessages(rendered)) return cloneChatRequest(rendered);
    }
    if (hasMessages(state?.chatRequest)) return cloneChatRequest(state.chatRequest);
    if (state?.canonicalSession) {
        const rendered = renderCanonicalToChat(state.canonicalSession);
        if (hasMessages(rendered)) return cloneChatRequest(rendered);
    }
    return cloneChatRequest(fallback || {messages: []});
}

function storedChatRequestFields(request, maxStoredChatMessages) {
    const stored = limitStoredChatRequest(request, maxStoredChatMessages);
    return {
        chatRequest: stored.request,
        chatRequestTruncated: stored.truncated,
        chatRequestMessageCount: stored.messageCount
    };
}

function limitStoredChatRequest(request, maxStoredChatMessages) {
    const cloned = cloneChatRequest(request);
    const messages = Array.isArray(cloned.messages) ? cloned.messages : [];
    const messageCount = messages.length;
    if (!maxStoredChatMessages || messageCount <= maxStoredChatMessages) {
        return {request: cloned, truncated: false, messageCount};
    }

    return {
        request: {
            ...cloned,
            messages: messages.slice(-maxStoredChatMessages)
        },
        truncated: true,
        messageCount
    };
}

function storedCanonicalSessionFields(session, maxCanonicalTurns) {
    const stored = limitCanonicalSession(session, maxCanonicalTurns);
    return {
        canonicalSession: stored.session,
        canonicalSessionTruncated: stored.truncated,
        canonicalTurnCount: stored.turnCount
    };
}

function limitCanonicalSession(session, maxCanonicalTurns) {
    const cloned = clone(session) || {turns: [], toolMappings: []};
    const turns = Array.isArray(cloned.turns) ? cloned.turns : [];
    const turnCount = turns.length;
    if (!maxCanonicalTurns || turnCount <= maxCanonicalTurns) {
        cloned.turns = turns;
        if (!Array.isArray(cloned.toolMappings)) cloned.toolMappings = [];
        return {session: cloned, truncated: false, turnCount};
    }

    const leadingSystemTurns = [];
    for (const turn of turns) {
        if (turn?.role !== 'system') break;
        if (leadingSystemTurns.length < maxCanonicalTurns) leadingSystemTurns.push(turn);
    }

    const remainingCapacity = Math.max(maxCanonicalTurns - leadingSystemTurns.length, 0);
    const nonSystemTurns = turns.slice(leadingSystemTurns.length);
    let retainedTurns = remainingCapacity > 0
        ? [...leadingSystemTurns, ...nonSystemTurns.slice(-remainingCapacity)]
        : leadingSystemTurns.slice(0, maxCanonicalTurns);
    retainedTurns = removeOrphanCanonicalToolResults(retainedTurns);

    const referencedToolCallIds = collectCanonicalToolCallIds(retainedTurns);
    const originalMappings = Array.isArray(cloned.toolMappings) ? cloned.toolMappings : [];
    cloned.turns = retainedTurns;
    cloned.toolMappings = referencedToolCallIds.size > 0
        ? originalMappings.filter((mapping) => referencedToolCallIds.has(mapping?.canonicalToolCallId))
        : [];

    return {
        session: cloned,
        truncated: retainedTurns.length !== turnCount || cloned.toolMappings.length !== originalMappings.length,
        turnCount
    };
}

function collectCanonicalToolCallIds(turns = []) {
    const ids = new Set();
    for (const turn of turns) {
        for (const block of turn?.blocks || []) {
            if ((block?.type === 'tool_call' || block?.type === 'tool_result') && block.canonicalToolCallId) {
                ids.add(block.canonicalToolCallId);
            }
        }
    }
    return ids;
}

function removeOrphanCanonicalToolResults(turns = []) {
    const toolCallIds = new Set();
    for (const turn of turns) {
        for (const block of turn?.blocks || []) {
            if (block?.type === 'tool_call' && block.canonicalToolCallId) {
                toolCallIds.add(block.canonicalToolCallId);
            }
        }
    }

    return turns
        .map((turn) => {
            const blocks = Array.isArray(turn?.blocks) ? turn.blocks : [];
            const retainedBlocks = blocks.filter((block) =>
                block?.type !== 'tool_result'
                || !block.canonicalToolCallId
                || toolCallIds.has(block.canonicalToolCallId)
            );
            return {...turn, blocks: retainedBlocks};
        })
        .filter((turn) => turn?.role === 'system' || (Array.isArray(turn?.blocks) && turn.blocks.length > 0));
}

function canonicalSessionForSave({request, tenantId, conversationKey, existing, sourceCanonicalSession, mappingCanonicalSession}) {
    const chatCanonical = canonicalFromChatRequest(request, {tenantId, conversationKey});
    const base = sourceCanonicalSession ? clone(sourceCanonicalSession) : chatCanonical;
    if (base) {
        base.tenantId = base.tenantId || tenantId;
        base.conversationKey = base.conversationKey || conversationKey;
    }
    return preserveCanonicalToolMappings(
        preserveCanonicalToolMappings(
            preserveCanonicalToolMappings(base, chatCanonical),
            mappingCanonicalSession
        ),
        existing?.canonicalSession
    );
}

function cloneState(state) {
    return {
        ...state,
        chatRequest: cloneChatRequest(state.chatRequest),
        chatRequestTruncated: state.chatRequestTruncated === true,
        chatRequestMessageCount: state.chatRequestMessageCount || 0,
        canonicalSession: clone(state.canonicalSession),
        canonicalSessionTruncated: state.canonicalSessionTruncated === true,
        canonicalTurnCount: state.canonicalTurnCount || 0,
        responses: new Set(state.responses || []),
        lastResponseId: state.lastResponseId || null
    };
}

function mergeChatRequests(base, visibleChat, originalResponsesRequest) {
    const baseMessages = base.messages || [];
    const visibleMessages = visibleChat.messages || [];
    const duplicatePrefixLength = getDuplicatePrefixLength(baseMessages, visibleMessages);
    const messages = [...baseMessages, ...visibleMessages.slice(duplicatePrefixLength)];
    return {
        ...base,
        ...visibleChat,
        model: visibleChat.model || originalResponsesRequest?.model || base.model,
        messages,
        stream: originalResponsesRequest?.stream
    };
}

function getDuplicatePrefixLength(baseMessages, visibleMessages) {
    // 处理 system 消息偏移：base 可能有 relay 注入的 system 消息而 visible 没有，
    // 或反之。跳过单侧的 system 前缀后再做前缀匹配。
    let baseOffset = 0;
    let visibleOffset = 0;

    if (baseMessages[0]?.role === 'system' && visibleMessages[0]?.role !== 'system') {
        baseOffset = 1;
    } else if (visibleMessages[0]?.role === 'system' && baseMessages[0]?.role !== 'system') {
        visibleOffset = 1;
    }

    let commonPrefixLength = 0;
    const maxBase = baseMessages.length - baseOffset;
    const maxVisible = visibleMessages.length - visibleOffset;
    const max = Math.min(maxBase, maxVisible);
    while (
        commonPrefixLength < max
        && messagesEqual(baseMessages[baseOffset + commonPrefixLength], visibleMessages[visibleOffset + commonPrefixLength])
    ) {
        commonPrefixLength++;
    }

    if (commonPrefixLength === 0) return 0;
    // 返回 visible 中已被 base 覆盖的消息数量
    return visibleOffset + commonPrefixLength;
}

function messagesEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
    return JSON.stringify(sortObject(value));
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;

    return Object.keys(value)
        .sort()
        .reduce((result, key) => {
            result[key] = sortObject(value[key]);
            return result;
        }, {});
}

function appendAssistantFromChatResponse(existingRequest, chatResponse) {
    const base = cloneChatRequest(existingRequest || {model: chatResponse?.model, messages: []});
    const message = chatResponse?.choices?.[0]?.message;
    if (message) {
        base.messages = [...(base.messages || []), clone(message)];
    }
    return base;
}
