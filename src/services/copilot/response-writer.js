import {isNetworkError} from '../../utils/http-client.js';
import {ResponsesWebSocketError} from '../shared/index.js';

export function sendCopilotJsonResponse(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

export function sendCopilotOpenAIError(res, status, message, type = 'api_error') {
    sendCopilotJsonResponse(res, status, {error: {message, type, code: status}});
}

export function sendCopilotAnthropicError(res, status, message) {
    const errorType = status === 401 ? 'authentication_error' : status === 503 ? 'overloaded_error' : 'api_error';
    sendCopilotJsonResponse(res, status, {type: 'error', error: {type: errorType, message}});
}

export function isCopilotResponsesProtocolError(err) {
    return err instanceof ResponsesWebSocketError && err?.event?.type === 'error';
}

export function sendCopilotResponsesProtocolError(res, err) {
    const event = err?.event || {
        type: 'error',
        status: err?.status || 400,
        error: {
            message: err?.message || 'Responses WebSocket request failed'
        }
    };

    if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
        }
        return;
    }

    sendCopilotJsonResponse(res, event.status || err?.status || 400, event);
}

export function copilotUpstreamErrorStatus(err) {
    return isNetworkError(err) ? 502 : 500;
}
