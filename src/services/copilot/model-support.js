export function supportsCopilotResponsesWebSocket(model) {
    return typeof model === 'string' && /^gpt(?:-|$)/i.test(model.trim());
}

export function ensureCopilotResponsesWebSocketSupported(model) {
    if (!supportsCopilotResponsesWebSocket(model)) {
        throw new Error(`Responses WebSocket is only supported for GPT-series models: ${model || 'unknown'}`);
    }
}
