/**
 * Copilot WebSocket 连接池
 * 按 copilotToken 维护空闲 WS 连接，支持复用
 * @module services/copilot/copilot-ws-pool
 */

import {connectWebSocket, sendRequest} from './copilot-ws-client.js';
import {wsHeaders, getCopilotBaseUrl} from './config.js';
import logger from '../../utils/logger.js';

const IDLE_TIMEOUT = 60000;
const MAX_PER_TOKEN = 5;

class PooledConnection {
    constructor(ws, tokenKey) {
        this.ws = ws;
        this.tokenKey = tokenKey;
        this.busy = false;
        this.createdAt = Date.now();
        this.lastUsedAt = Date.now();
        this.idleTimer = null;
        this.contextKey = null;
        this.lastResponseId = null;
    }
}

const pools = new Map();

function tokenKey(copilotToken) {
    let hash = 0;
    for (let i = 0; i < copilotToken.length; i++) {
        hash = ((hash << 5) - hash + copilotToken.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

export function connectionPoolKey(copilotToken, proxyKey) {
    return `${tokenKey(copilotToken)}:${proxyKey || 'direct'}`;
}

function getPool(key) {
    if (!pools.has(key)) pools.set(key, []);
    return pools.get(key);
}

function startIdleTimer(conn) {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = setTimeout(() => {
        removeConnection(conn);
    }, IDLE_TIMEOUT);
}

function stopIdleTimer(conn) {
    if (conn.idleTimer) {
        clearTimeout(conn.idleTimer);
        conn.idleTimer = null;
    }
}

function normalizeContextKey(contextKey) {
    return typeof contextKey === 'string' && contextKey.trim() ? contextKey.trim() : null;
}

function normalizeResponseId(responseId) {
    return typeof responseId === 'string' && responseId.trim() ? responseId.trim() : null;
}

function bindConnectionContext(conn, contextKey, preserveResponseId = false) {
    const normalizedContextKey = normalizeContextKey(contextKey);
    if (conn.contextKey !== normalizedContextKey) {
        conn.contextKey = normalizedContextKey;
        if (!preserveResponseId) conn.lastResponseId = null;
    }
}

function removeConnection(conn) {
    stopIdleTimer(conn);
    try { conn.ws.close(); } catch {}
    const pool = pools.get(conn.tokenKey);
    if (pool) {
        const idx = pool.indexOf(conn);
        if (idx !== -1) pool.splice(idx, 1);
        if (pool.length === 0) pools.delete(conn.tokenKey);
    }
}

export async function acquire(copilotToken, vsCodeVersion, accountType = 'individual', agent, rejectUnauthorized = true, contextKey, preferredPreviousResponseId, proxyKey) {
    const key = connectionPoolKey(copilotToken, proxyKey);
    const pool = getPool(key);
    const normalizedContextKey = normalizeContextKey(contextKey);
    const normalizedPreviousResponseId = normalizeResponseId(preferredPreviousResponseId);

    if (normalizedPreviousResponseId) {
        for (const conn of pool) {
            if (!conn.busy && conn.ws.readyState === 1 && conn.lastResponseId === normalizedPreviousResponseId) {
                conn.busy = true;
                conn.lastUsedAt = Date.now();
                stopIdleTimer(conn);
                bindConnectionContext(conn, normalizedContextKey ?? conn.contextKey, true);
                logger.info(`WS pool: reusing connection by previous_response_id for ${normalizedPreviousResponseId}`);
                return conn;
            }
        }
    }

    if (normalizedContextKey) {
        for (const conn of pool) {
            if (!conn.busy && conn.ws.readyState === 1 && conn.contextKey === normalizedContextKey) {
                conn.busy = true;
                conn.lastUsedAt = Date.now();
                stopIdleTimer(conn);
                return conn;
            }
        }
    }

    for (const conn of pool) {
        if (!conn.busy && conn.ws.readyState === 1 && !conn.contextKey) {
            conn.busy = true;
            conn.lastUsedAt = Date.now();
            stopIdleTimer(conn);
            bindConnectionContext(conn, normalizedContextKey, false);
            return conn;
        }
    }

    for (const conn of pool) {
        if (!conn.busy && conn.ws.readyState === 1) {
            conn.busy = true;
            conn.lastUsedAt = Date.now();
            stopIdleTimer(conn);
            bindConnectionContext(conn, normalizedContextKey, false);
            return conn;
        }
    }

    const baseUrl = getCopilotBaseUrl(accountType);
    const wsUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/responses';
    const headers = wsHeaders(copilotToken, vsCodeVersion);

    logger.info(`WS pool: creating new connection to ${wsUrl}`);
    const ws = await connectWebSocket(wsUrl, headers, agent, undefined, rejectUnauthorized);

    const conn = new PooledConnection(ws, key);
    conn.busy = true;
    bindConnectionContext(conn, normalizedContextKey, false);
    pool.push(conn);

    ws.on('close', () => removeConnection(conn));
    ws.on('error', (err) => {
        logger.warn(`WS pool: connection error: ${err.message}`);
        removeConnection(conn);
    });

    while (pool.length > MAX_PER_TOKEN) {
        const oldest = pool.find(c => !c.busy);
        if (oldest) removeConnection(oldest);
        else break;
    }

    return conn;
}

export function release(conn) {
    if (conn.ws.readyState !== 1) {
        removeConnection(conn);
        return;
    }
    conn.busy = false;
    conn.lastUsedAt = Date.now();
    startIdleTimer(conn);
}

export function discard(conn) {
    removeConnection(conn);
}

export function shutdown() {
    for (const [, pool] of pools) {
        for (const conn of pool) {
            stopIdleTimer(conn);
            try { conn.ws.close(); } catch {}
        }
    }
    pools.clear();
}

export {sendRequest};
