export function normalizeCopilotConversationKey(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractCopilotConversationKeyFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return undefined;

    const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : undefined;

    const candidates = [
        payload.conversation_id,
        payload.conversationId,
        payload.session_id,
        payload.sessionId,
        payload.thread_id,
        payload.threadId,
        metadata?.conversation_id,
        metadata?.conversationId,
        metadata?.session_id,
        metadata?.sessionId,
        metadata?.thread_id,
        metadata?.threadId
    ];

    for (const candidate of candidates) {
        const normalized = normalizeCopilotConversationKey(candidate);
        if (normalized) return normalized;
    }

    return undefined;
}

export function extractCopilotConversationKey(req, payload) {
    const headerCandidates = [
        req.headers['x-conversation-id'],
        req.headers['x-session-id'],
        req.headers['x-chat-id'],
        req.headers['x-thread-id']
    ];

    for (const candidate of headerCandidates) {
        const value = Array.isArray(candidate) ? candidate[0] : candidate;
        const normalized = normalizeCopilotConversationKey(value);
        if (normalized) return normalized;
    }

    return extractCopilotConversationKeyFromPayload(payload);
}
