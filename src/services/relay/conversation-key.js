/**
 * Relay conversation key extraction helpers.
 * Keeps route handlers from carrying protocol-specific session heuristics.
 * @module services/relay/conversation-key
 */

import {buildConversationAnchorKey} from './protocol-adapter.js';

export function normalizeConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : undefined;
    const candidates = [
        payload.session_id,
        payload.sessionId,
        metadata?.session_id,
        metadata?.sessionId,
        payload.conversation,
        metadata?.conversation,
        payload.conversation_id,
        payload.conversationId,
        metadata?.conversation_id,
        metadata?.conversationId,
        payload.thread_id,
        payload.threadId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeConversationCandidate(candidate);
        if (normalized) return normalized;
    }
    return undefined;
}

export function extractConversationKey(req, payload, meta = {}) {
    const headerCandidates = [
        req.headers['x-claude-code-session-id'],
        req.headers['x-session-id'],
        req.headers['x-conversation-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeConversationCandidate(value);
        if (normalized) return normalized;
    }

    const payloadResult = extractConversationKeyFromPayload(payload);
    if (payloadResult) return payloadResult;

    const keyMeta = {
        ...meta,
        ...(req.relayClientConnectionId && !meta.clientConnectionId
            ? {clientConnectionId: req.relayClientConnectionId}
            : {})
    };

    const anchorPayload = payload && typeof payload === 'object'
        ? {...payload, messages: payload?.messages || payload?.input}
        : {messages: payload?.messages || payload?.input};
    return buildConversationAnchorKey(anchorPayload, keyMeta);
}

function normalizeConversationCandidate(value) {
    if (typeof value === 'object' && value !== null) {
        return normalizeConversationKey(
            value.id
            || value.conversation_id
            || value.conversationId
        );
    }
    return normalizeConversationKey(value);
}
