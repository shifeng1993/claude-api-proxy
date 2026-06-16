import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import {sanitizeResponsesInput} from '../../transformer/responses-translator.js';

const CONNECT_TIMEOUT = 30000;
// 上游 WS 心跳间隔，防止中间代理因空闲超时切断连接
const UPSTREAM_PING_INTERVAL = 25000;

export class ResponsesWebSocketError extends Error {
    constructor(event) {
        const errorInfo = event?.error || {};
        super(errorInfo.message || 'Responses WebSocket request failed');
        this.name = 'ResponsesWebSocketError';
        this.event = event;
        this.status = event?.status;
        this.code = errorInfo.code;
        this.param = errorInfo.param;
        this.type = errorInfo.type;
    }
}

export function isResponsesWebSocketProtocolError(error) {
    return error?.name === 'ResponsesWebSocketError' && error?.event?.type === 'error';
}

export function prepareResponsesWebSocketPayload(payload) {
    const {stream, background, ...rest} = payload || {};
    return rest;
}

export function connectResponsesWebSocket(url, headers, agent, timeout = CONNECT_TIMEOUT, rejectUnauthorized = true) {
    return new Promise((resolve, reject) => {
        let socket;
        const timer = setTimeout(() => {
            try {
                socket?.close();
            } catch {}
            reject(new Error(`WebSocket connect timeout after ${timeout}ms`));
        }, timeout);

        const socketOptions = {headers, handshakeTimeout: timeout, rejectUnauthorized};
        if (agent) socketOptions.agent = agent;

        socket = new WebSocket(url, socketOptions);

        socket.on('open', () => {
            clearTimeout(timer);
            // 启动上游 WS 心跳，防止中间代理因空闲超时切断连接
            socket._upstreamPingTimer = setInterval(() => {
                if (socket.readyState === 1) {
                    try { socket.ping(); } catch { stopUpstreamPing(socket); }
                } else {
                    stopUpstreamPing(socket);
                }
            }, UPSTREAM_PING_INTERVAL);
            resolve(socket);
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            stopUpstreamPing(socket);
            reject(error);
        });

        socket.on('unexpected-response', (_req, response) => {
            clearTimeout(timer);
            let body = '';
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => reject(new Error(`WebSocket upgrade failed: ${response.statusCode} ${body.slice(0, 200)}`)));
        });

        socket.on('close', () => {
            stopUpstreamPing(socket);
        });
    });
}

function stopUpstreamPing(socket) {
    if (socket?._upstreamPingTimer) {
        clearInterval(socket._upstreamPingTimer);
        socket._upstreamPingTimer = null;
    }
}

export async function* sendResponsesWebSocketRequest(socketOrConnection, payload) {
    const socket = socketOrConnection?.ws || socketOrConnection;
    const connection = socketOrConnection?.ws ? socketOrConnection : null;
    let resolveMessage;
    let rejectMessage;
    const messageQueue = [];
    let streamDone = false;
    let streamError = null;
    let responseCompleted = false;
    let closeCode = null;
    let closeReason = '';

    if (Array.isArray(payload.input)) {
        payload = {...payload, input: sanitizeResponsesInput(payload.input)};
    }

    const explicitPreviousResponseId =
        typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
            ? payload.previous_response_id.trim()
            : null;
    const autoPreviousResponseId = !explicitPreviousResponseId && connection?.contextKey && connection.lastResponseId
        ? connection.lastResponseId
        : null;
    const referencedPreviousResponseId = explicitPreviousResponseId || autoPreviousResponseId;

    if (explicitPreviousResponseId) {
        payload = {...payload, previous_response_id: explicitPreviousResponseId};
    } else if (autoPreviousResponseId) {
        logger.info(`Responses WS: auto-linking context with previous_response_id=${autoPreviousResponseId}`);
        payload = {...payload, previous_response_id: autoPreviousResponseId};
    }

    const onMessage = (raw) => {
        let parsed;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch (error) {
            logger.warn('Responses WS: failed to parse message:', error.message);
            return;
        }

        if (connection && parsed.type === 'response.created' && parsed.response?.id) {
            connection.lastResponseId = parsed.response.id;
        }

        if (parsed.type === 'error') {
            if (connection && referencedPreviousResponseId && connection.lastResponseId === referencedPreviousResponseId) {
                connection.lastResponseId = null;
            }
            streamDone = true;
            streamError = new ResponsesWebSocketError(parsed);
            if (parsed.error?.code === 'websocket_connection_limit_reached') {
                try {
                    socket.close();
                } catch {}
            }
            if (resolveMessage) {
                const resolve = resolveMessage;
                resolveMessage = null;
                rejectMessage = null;
                resolve();
            }
            return;
        }

        messageQueue.push(parsed);
        if (resolveMessage) {
            const resolve = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            resolve();
        }
    };

    const onError = (error) => {
        streamError = error;
        if (rejectMessage) {
            const reject = rejectMessage;
            resolveMessage = null;
            rejectMessage = null;
            reject(error);
        }
    };

    const onClose = (code, reason) => {
        closeCode = code;
        closeReason = reason ? reason.toString('utf8') : '';
        logger.info(`Responses WS: upstream closed (code=${code}, reason=${closeReason || '(empty)'}, responseCompleted=${responseCompleted})`);
        streamDone = true;
        if (resolveMessage) {
            const resolve = resolveMessage;
            resolveMessage = null;
            rejectMessage = null;
            resolve();
        }
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);

    socket.send(JSON.stringify({type: 'response.create', ...prepareResponsesWebSocketPayload(payload)}));

    try {
        while (!streamDone || messageQueue.length > 0) {
            if (streamError && messageQueue.length === 0) throw streamError;
            if (messageQueue.length > 0) {
                const message = messageQueue.shift();
                yield {type: message.type, data: message};
                if (message.type === 'response.completed') {
                    responseCompleted = true;
                    break;
                }
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
        // 上游在 response.completed 之前关闭了连接 — 必须抛出错误，
        // 否则客户端（如 codex）会收到 "stream closed before response.completed"
        if (!responseCompleted) {
            const detail = closeCode ? ` (code=${closeCode}${closeReason ? ', reason=' + closeReason : ''})` : '';
            throw new ResponsesWebSocketError({
                type: 'error',
                error: {
                    message: `stream closed before response.completed${detail}`,
                    code: 'stream_disconnected'
                }
            });
        }
    } finally {
        socket.off('message', onMessage);
        socket.off('error', onError);
        socket.off('close', onClose);
    }
}
