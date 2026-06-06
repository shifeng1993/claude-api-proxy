import {connectResponsesWebSocket, sendResponsesWebSocketRequest} from './responses-ws-client.js';
import logger from '../../utils/logger.js';

const IDLE_TIMEOUT = 60000;
const MAX_PER_KEY = 5;

class PooledConnection {
    constructor(ws, poolKey) {
        this.ws = ws;
        this.poolKey = poolKey;
        this.busy = false;
        this.createdAt = Date.now();
        this.lastUsedAt = Date.now();
        this.idleTimer = null;
        this.contextKey = null;
        this.lastResponseId = null;
    }
}

const pools = new Map();

function stableKey(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

export function connectionPoolKey(authKey, networkKey) {
    return `${stableKey(authKey)}:${networkKey || 'direct'}`;
}

function getPool(key) {
    if (!pools.has(key)) pools.set(key, []);
    return pools.get(key);
}

function startIdleTimer(connection) {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
        removeConnection(connection);
    }, IDLE_TIMEOUT);
}

function stopIdleTimer(connection) {
    if (connection.idleTimer) {
        clearTimeout(connection.idleTimer);
        connection.idleTimer = null;
    }
}

function normalizeContextKey(contextKey) {
    return typeof contextKey === 'string' && contextKey.trim() ? contextKey.trim() : null;
}

function normalizeResponseId(responseId) {
    return typeof responseId === 'string' && responseId.trim() ? responseId.trim() : null;
}

function bindConnectionContext(connection, contextKey, preserveResponseId = false) {
    const normalizedContextKey = normalizeContextKey(contextKey);
    if (connection.contextKey !== normalizedContextKey) {
        connection.contextKey = normalizedContextKey;
        if (!preserveResponseId) connection.lastResponseId = null;
    }
}

function removeConnection(connection) {
    stopIdleTimer(connection);
    try {
        connection.ws.close();
    } catch {}
    const pool = pools.get(connection.poolKey);
    if (pool) {
        const index = pool.indexOf(connection);
        if (index !== -1) pool.splice(index, 1);
        if (pool.length === 0) pools.delete(connection.poolKey);
    }
}

export async function acquire({
    url,
    headers,
    authKey,
    agent,
    rejectUnauthorized = true,
    contextKey,
    preferredPreviousResponseId,
    networkKey
}) {
    const key = connectionPoolKey(`${url}:${authKey || ''}`, networkKey);
    const pool = getPool(key);
    const normalizedContextKey = normalizeContextKey(contextKey);
    const normalizedPreviousResponseId = normalizeResponseId(preferredPreviousResponseId);

    if (normalizedPreviousResponseId) {
        for (const connection of pool) {
            if (!connection.busy && connection.ws.readyState === 1 && connection.lastResponseId === normalizedPreviousResponseId) {
                connection.busy = true;
                connection.lastUsedAt = Date.now();
                stopIdleTimer(connection);
                bindConnectionContext(connection, normalizedContextKey ?? connection.contextKey, true);
                logger.info(`Responses WS pool: reusing connection by previous_response_id=${normalizedPreviousResponseId}`);
                return connection;
            }
        }
    }

    if (normalizedContextKey) {
        for (const connection of pool) {
            if (!connection.busy && connection.ws.readyState === 1 && connection.contextKey === normalizedContextKey) {
                connection.busy = true;
                connection.lastUsedAt = Date.now();
                stopIdleTimer(connection);
                return connection;
            }
        }
    }

    for (const connection of pool) {
        if (!connection.busy && connection.ws.readyState === 1 && !connection.contextKey) {
            connection.busy = true;
            connection.lastUsedAt = Date.now();
            stopIdleTimer(connection);
            bindConnectionContext(connection, normalizedContextKey, false);
            return connection;
        }
    }

    for (const connection of pool) {
        if (!connection.busy && connection.ws.readyState === 1) {
            connection.busy = true;
            connection.lastUsedAt = Date.now();
            stopIdleTimer(connection);
            bindConnectionContext(connection, normalizedContextKey, false);
            return connection;
        }
    }

    logger.info(`Responses WS pool: creating new connection to ${url}`);
    const ws = await connectResponsesWebSocket(url, headers, agent, undefined, rejectUnauthorized);
    const connection = new PooledConnection(ws, key);
    connection.busy = true;
    bindConnectionContext(connection, normalizedContextKey, false);
    pool.push(connection);

    ws.on('close', () => removeConnection(connection));
    ws.on('error', (error) => {
        logger.warn(`Responses WS pool: connection error: ${error.message}`);
        removeConnection(connection);
    });

    while (pool.length > MAX_PER_KEY) {
        const oldest = pool.find((item) => !item.busy);
        if (oldest) removeConnection(oldest);
        else break;
    }

    return connection;
}

export function release(connection) {
    if (connection.ws.readyState !== 1) {
        removeConnection(connection);
        return;
    }
    connection.busy = false;
    connection.lastUsedAt = Date.now();
    startIdleTimer(connection);
}

export function discard(connection) {
    removeConnection(connection);
}

export function shutdown() {
    for (const [, pool] of pools) {
        for (const connection of pool) {
            stopIdleTimer(connection);
            try {
                connection.ws.close();
            } catch {}
        }
    }
    pools.clear();
}

/**
 * 根据连接池 key 清除匹配的连接
 * 用于上游切换后清理旧连接，避免复用已切换上游的连接
 * @param {string} poolKey - 连接池 key（由 connectionPoolKey 生成）
 */
export function discardByPoolKey(poolKey) {
    const pool = pools.get(poolKey);
    if (!pool) return;
    // 复制数组避免遍历时修改
    const connections = [...pool];
    for (const connection of connections) {
        removeConnection(connection);
    }
    pools.delete(poolKey);
    logger.info(`Responses WS pool: discarded ${connections.length} connections for poolKey=${poolKey}`);
}

export {sendResponsesWebSocketRequest as sendRequest};