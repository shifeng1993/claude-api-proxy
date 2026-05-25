import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import {sanitizeResponsesInput} from '../../transformer/responses-translator.js';

const CONNECT_TIMEOUT = 30000;

export class CopilotResponsesWSError extends Error {
    constructor(event) {
        const errorInfo = event?.error || {};
        super(errorInfo.message || 'Responses WebSocket request failed');
        this.name = 'CopilotResponsesWSError';
        this.event = event;
        this.status = event?.status;
        this.code = errorInfo.code;
        this.param = errorInfo.param;
        this.type = errorInfo.type;
    }
}

export function prepareWebSocketPayload(payload) {
    const {stream, background, ...rest} = payload || {};
    return rest;
}

export function connectWebSocket(url, headers, agent, timeout = CONNECT_TIMEOUT, rejectUnauthorized = true) {
    return new Promise((resolve, reject) => {
        let ws;
        const timer = setTimeout(() => {
            try { ws?.close(); } catch {}
            reject(new Error(`WebSocket connect timeout after ${timeout}ms`));
        }, timeout);

        const wsOptions = {headers, handshakeTimeout: timeout, rejectUnauthorized};
        if (agent) wsOptions.agent = agent;

        ws = new WebSocket(url, wsOptions);

        ws.on('open', () => {
            clearTimeout(timer);
            resolve(ws);
        });

        ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        ws.on('unexpected-response', (req, res) => {
            clearTimeout(timer);
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => reject(new Error(`WebSocket upgrade failed: ${res.statusCode} ${body.slice(0, 200)}`)));
        });
    });
}

export async function* sendRequest(wsOrConn, payload) {
    const ws = wsOrConn?.ws || wsOrConn;
    const conn = wsOrConn?.ws ? wsOrConn : null;
    let resolveMessage;
    let rejectMessage;
    let messageQueue = [];
    let streamDone = false;
    let streamError = null;

    if (Array.isArray(payload.input)) {
        const beforeTypes = payload.input.map(i => i?.type || i?.role || 'unknown');
        payload = {...payload, input: sanitizeResponsesInput(payload.input)};
        const afterTypes = payload.input.map(i => i?.type || i?.role || 'unknown');
        if (beforeTypes.join(',') !== afterTypes.join(',')) {
            logger.info(`WS: sanitized input types [${beforeTypes}] → [${afterTypes}]`);
        }
    }

    const explicitPreviousResponseId = typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
        ? payload.previous_response_id.trim()
        : null;
    const autoPreviousResponseId = !explicitPreviousResponseId && conn?.contextKey && conn.lastResponseId
        ? conn.lastResponseId
        : null;
    const referencedPreviousResponseId = explicitPreviousResponseId || autoPreviousResponseId;

    if (explicitPreviousResponseId) {
        payload = {...payload, previous_response_id: explicitPreviousResponseId};
    } else if (autoPreviousResponseId) {
        logger.info(`WS: auto-linking context with previous_response_id=${autoPreviousResponseId}`);
        payload = {...payload, previous_response_id: autoPreviousResponseId};
    }

    const onMessage = (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            logger.warn('WS: Failed to parse message:', e.message);
            return;
        }

        if (conn && parsed.type === 'response.created' && parsed.response?.id) {
            conn.lastResponseId = parsed.response.id;
        }

        if (parsed.type === 'error') {
            if (conn && referencedPreviousResponseId && conn.lastResponseId === referencedPreviousResponseId) {
                conn.lastResponseId = null;
            }
            streamDone = true;
            streamError = new CopilotResponsesWSError(parsed);
            if (parsed.error?.code === 'websocket_connection_limit_reached') {
                try { ws.close(); } catch {}
            }
            if (resolveMessage) {
                const r = resolveMessage;
                resolveMessage = null;
                rejectMessage = null;
                r();
            }
            return;
        }

        messageQueue.push(parsed);
        if (resolveMessage) {
            const r = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            r();
        }
    };

    const onError = (err) => {
        streamError = err;
        if (rejectMessage) {
            const r = rejectMessage;
            resolveMessage = null;
            rejectMessage = null;
            r(err);
        }
    };

    const onClose = () => {
        streamDone = true;
        if (resolveMessage) {
            const r = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            r();
        }
    };

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);

    ws.send(JSON.stringify({type: 'response.create', ...prepareWebSocketPayload(payload)}));

    try {
        while (!streamDone || messageQueue.length > 0) {
            if (streamError && messageQueue.length === 0) throw streamError;
            if (messageQueue.length > 0) {
                const msg = messageQueue.shift();
                yield {type: msg.type, data: msg};
                if (msg.type === 'response.completed') break;
                continue;
            }
            if (streamDone) break;
            await new Promise((resolve, reject) => {
                resolveMessage = resolve;
                rejectMessage = reject;
            });
            if (streamError) throw streamError;
        }
        if (streamError) throw streamError;
    } finally {
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
    }
}
