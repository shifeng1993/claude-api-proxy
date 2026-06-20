import {responsesRequestToChat, responsesResponseToChat} from '../../transformer/responses-translator.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
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
    constructor({ttlMs = DEFAULT_TTL_MS, cleanupIntervalMs, now = () => Date.now()} = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.conversations = new Map();
        this.responseIndex = new Map();
        this.cleanupTimer = null;

        cleanupIntervalMs = cleanupIntervalMs ?? Math.min(ttlMs, DEFAULT_CLEANUP_INTERVAL_MS);
        if (cleanupIntervalMs > 0) {
            this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupIntervalMs);
            this.cleanupTimer.unref?.();
        }
    }

    saveChatRequest({tenantId, conversationKey, request}) {
        const key = this._conversationKey(tenantId, conversationKey);
        if (!key || !request) return null;

        const existing = this._getByConversationKey(tenantId, conversationKey);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: cloneChatRequest(request),
            responses: new Set(existing?.responses || []),
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

        const visibleChat = responsesRequestToChat(request || {});
        const base = state?.chatRequest ? cloneChatRequest(state.chatRequest) : {model: request?.model, messages: []};
        const chatRequest = mergeChatRequests(base, visibleChat, request);
        const resolvedConversationKey = state?.conversationKey || conversationKey;

        if (resolvedConversationKey) {
            this.saveChatRequest({tenantId, conversationKey: resolvedConversationKey, request: chatRequest});
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
            const visibleChat = responsesRequestToChat(request || {});
            const base = state?.chatRequest ? cloneChatRequest(state.chatRequest) : {model: request?.model, messages: []};
            const chatRequest = mergeChatRequests(base, visibleChat, request);
            this.saveChatRequest({tenantId, conversationKey: resolvedConversationKey, request: chatRequest});
        }
        return {
            conversationKey: resolvedConversationKey,
            request: {...request},
            lastResponseId: getLatestResponseId(state)
        };
    }

    recordResponsesResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;

        const key = this._conversationKey(tenantId, conversationKey);
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const chatResponse = responsesResponseToChat(response);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, chatResponse);
        const state = {
            tenantId,
            conversationKey,
            chatRequest: nextRequest,
            responses: new Set(existing?.responses || []),
            updatedAt: this.now()
        };

        if (response.id) {
            state.responses.add(response.id);
            this.responseIndex.set(this._responseKey(tenantId, response.id), key);
        }

        this.conversations.set(key, state);
        return cloneState(state);
    }

    recordChatResponse({tenantId, conversationKey, response}) {
        if (!response || !conversationKey) return null;
        const existing = this._getByConversationKey(tenantId, conversationKey);
        const nextRequest = appendAssistantFromChatResponse(existing?.chatRequest, response);
        return this.saveChatRequest({tenantId, conversationKey, request: nextRequest});
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
    let latest = null;
    for (const responseId of state?.responses || []) {
        latest = responseId;
    }
    return latest;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cloneChatRequest(request) {
    return clone(request) || {messages: []};
}

function cloneState(state) {
    return {
        ...state,
        chatRequest: cloneChatRequest(state.chatRequest),
        responses: new Set(state.responses || [])
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
