/**
 * Provider API 调用模块
 * 向上游 LLM API 发送请求，支持 per-upstream 代理（HTTP/HTTPS/SOCKS5）及 agent 缓存
 * @module services/providers/upstream-api
 */

import https from 'https';
import {request, readBody} from '../../utils/http-client.js';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import {buildUrl} from '../../utils/helpers.js';
import {normalizePayload, normalizeResponsesPayload} from './protocol-adapter.js';
import {interceptAndSerialize} from '../../utils/payload-interceptor.js';
import {
    acquire as acquireResponsesWS,
    release as releaseResponsesWS,
    discard as discardResponsesWS,
    sendRequest as sendResponsesWSRequest
} from '../shared/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Provider 上游错误
 * 保留上游 HTTP 状态码，便于路由层区分 429 等特殊状态并透传
 */
export class ProviderUpstreamError extends Error {
    /**
     * @param {string} message - 错误信息（保持与原错误格式一致）
     * @param {number} status - 上游 HTTP 状态码
     */
    constructor(message, status) {
        super(message);
        this.name = 'ProviderUpstreamError';
        this.status = status;
    }
}

// ==================== 代理 Agent 缓存 ====================

/**
 * 以 "proxyUrl|tls-mode" 联合 key 缓存 agent 实例，避免每次请求重复创建
 * - tls-mode: skip-tls 表示 rejectUnauthorized=false（跳过 TLS 校验）
 * @type {Map<string, HttpsProxyAgent|SocksProxyAgent|https.Agent>}
 */
const proxyAgentCache = new Map();

/**
 * 获取代理 / TLS Agent（带缓存）
 * - 无 proxy 且非 skip_tls_verify：返回 undefined（直连，使用 Node 默认 agent）
 * - 无 proxy 且 skip_tls_verify：返回 https.Agent({rejectUnauthorized:false})（仅作用于 HTTPS）
 * - 有 proxy：根据协议构造 HttpsProxyAgent / SocksProxyAgent，并将 rejectUnauthorized 透传
 *
 * @param {object} upstream - 上游配置
 * @param {string} [upstream.proxy] - 代理地址
 * @param {boolean} [upstream.skip_tls_verify] - 是否跳过上游 TLS 证书校验
 * @returns {HttpsProxyAgent|SocksProxyAgent|https.Agent|undefined}
 */
export function getProxyAgent(upstream) {
    const proxyUrl = upstream.proxy;
    const skipTls = upstream.skip_tls_verify === true;
    const tlsKey = skipTls ? 'skip-tls' : 'verify-tls';
    const cacheKey = `${proxyUrl || 'no-proxy'}|${tlsKey}`;

    // 命中缓存
    if (proxyAgentCache.has(cacheKey)) {
        return proxyAgentCache.get(cacheKey);
    }

    // 无 proxy 分支：只有需要跳过 TLS 校验时才创建专用 Agent；否则直连
    if (!proxyUrl) {
        if (!skipTls) return undefined;
        const agent = new https.Agent({rejectUnauthorized: false});
        proxyAgentCache.set(cacheKey, agent);
        return agent;
    }

    // 有 proxy 分支
    let agent;
    try {
        const agentOptions = skipTls ? {rejectUnauthorized: false} : {};
        if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks://')) {
            agent = new SocksProxyAgent(proxyUrl, agentOptions);
        } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
            agent = new HttpsProxyAgent(proxyUrl, agentOptions);
        } else {
            logger.warn(`[${upstream.name}]: 不支持的代理协议 "${proxyUrl}"，将直连`);
            return undefined;
        }

        proxyAgentCache.set(cacheKey, agent);
        return agent;
    } catch (err) {
        logger.error(`[${upstream.name}]: 创建代理 Agent 失败 (${proxyUrl}): ${err.message}`);
        return undefined;
    }
}

// ==================== Chat Completions ====================

function normalizeAnthropicBaseUrl(baseUrl) {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/messages\/count_tokens$/, '');
    pathname = pathname.replace(/\/messages$/, '');
    pathname = pathname.replace(/\/models$/, '');
    if (!/\/v\d+$/i.test(pathname)) {
        pathname = `${pathname}/v1`;
    }
    url.pathname = pathname;
    return url.toString().replace(/\/+$/, '');
}

export function buildProtocolAwareUrl(upstream, endpoint) {
    if (!isAnthropicUpstream(upstream)) {
        return buildUrl(upstream.base_url, endpoint);
    }

    try {
        return buildUrl(normalizeAnthropicBaseUrl(upstream.base_url), endpoint);
    } catch {
        const normalizedBaseUrl = upstream.base_url.replace(/\/+$/, '');
        return buildUrl(normalizedBaseUrl, endpoint);
    }
}

export function normalizeUpstreamProtocol(protocol) {
    const normalized = String(protocol || '').trim().toLowerCase();
    return normalized || 'openai';
}

export function isAnthropicUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'anthropic';
}

function shouldUseBearerAuthForAnthropic(upstream) {
    const apiKey = String(upstream?.api_key || '').trim();
    try {
        const host = new URL(upstream?.base_url || '').hostname.toLowerCase();
        return apiKey.startsWith('ark-') || host.includes('volces.com') || host.includes('volcengine.com');
    } catch {
        return apiKey.startsWith('ark-');
    }
}

export function isResponsesUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'responses';
}

export function isResponsesWebSocketUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'responses_ws';
}

function buildBaseHeaders(upstream, extraHeaders = {}) {
    const headers = {
        'User-Agent': 'Relay/1.0',
        ...extraHeaders
    };

    if (isAnthropicUpstream(upstream)) {
        if (shouldUseBearerAuthForAnthropic(upstream)) {
            headers.Authorization = `Bearer ${upstream.api_key}`;
            delete headers['x-api-key'];
        } else {
            headers['x-api-key'] = upstream.api_key;
            delete headers.Authorization;
        }
        headers['anthropic-version'] = extraHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION;
        return headers;
    }

    headers.Authorization = `Bearer ${upstream.api_key}`;
    return headers;
}

function applyProxy(upstream, options) {
    const proxyAgent = getProxyAgent(upstream);
    if (proxyAgent) {
        options.agent = proxyAgent;
    }
}

export function buildResponsesWebSocketUrl(upstream, endpoint = 'responses') {
    const endpointPath = String(endpoint || 'responses').replace(/^\/+/, '');
    let url;
    try {
        url = new URL(upstream.base_url);
    } catch {
        throw new Error(`[${upstream.name}]: Responses WebSocket URL must be a valid URL`);
    }

    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        throw new Error(`[${upstream.name}]: Responses WebSocket URL must start with http://, https://, ws://, or wss://`);
    }

    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (!normalizedPath.endsWith(`/${endpointPath}`) && normalizedPath !== `/${endpointPath}`) {
        url.pathname = `${normalizedPath || ''}/${endpointPath}`.replace(/\/{2,}/g, '/');
    } else {
        url.pathname = normalizedPath || `/${endpointPath}`;
    }
    url.hash = '';

    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
}

export function buildResponsesWebSocketHeaders(upstream, extraHeaders = {}) {
    return buildBaseHeaders(upstream, {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extraHeaders
    });
}

async function requestJson(url, upstream, {method = 'POST', headers = {}, body, timeout = 300000} = {}) {
    const finalHeaders = buildBaseHeaders(upstream, headers);
    const options = {
        method,
        headers: finalHeaders,
        timeout
    };

    // skip_tls_verify 需要同时传给底层 http-client，否则 request() 会独立计算
    // rejectUnauthorized=true，覆盖 agent 里的设置
    if (upstream.skip_tls_verify === true) {
        options.rejectUnauthorized = false;
    }

    if (body !== undefined) {
        options.body = body;
    }

    applyProxy(upstream, options);
    return request(url, options);
}

/**
 * 向上游发送 OpenAI 格式的聊天请求
 *
 * @param {object} payload - OpenAI chat completions 请求体
 * @param {object} upstream - 上游配置
 * @param {string} upstream.name - 上游名称
 * @param {string} upstream.base_url - 上游基础 URL
 * @param {string} upstream.api_key - 上游 API Key
 * @param {string} [upstream.proxy] - 代理地址
 * @param {boolean} [upstream.enabled] - 是否启用
 * @returns {Promise<{status: number, headers: object, body: import('stream').Readable}>}
 * @throws {Error} 上游返回非 2xx 时抛出包含响应体的错误
 */
export async function createChatCompletions(payload, upstream, meta = {}) {
    const url = buildProtocolAwareUrl(upstream, 'chat/completions');

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    const reasoningEffort = payload.reasoning_effort || 'high';
    const userInfo = meta.tenantName && meta.tenantUsername ? `${meta.tenantName}(${meta.tenantUsername})` : '';
    logger.info(
        `[${upstream.name}]: ${upstream.base_url}, model: ${payload.model || 'unknown'}, effort: ${reasoningEffort}, proxy: ${proxyMode}, ${userInfo}`
    );

    // 腾讯云文档要求：prompt_cache_key 标识相同上下文的请求，提升缓存复用
    if (meta.conversationKey && !payload.prompt_cache_key) {
        payload.prompt_cache_key = meta.conversationKey;
    }

    // 缓存策略辅助头部：X-Session-ID 将同一用户的请求路由到同一推理实例
    const extraHeaders = {
        'Content-Type': 'application/json'
    };
    if (meta.sessionId) {
        extraHeaders['X-Session-ID'] = meta.sessionId;
    }

    const debugHeaders = buildBaseHeaders(upstream, extraHeaders);
    const normalizedPayload = normalizePayload(payload, {source: 'relay', upstream: upstream.name});

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: extraHeaders,
        body: interceptAndSerialize(normalizedPayload, {
            channel: 'relay',
            model: payload.model,
            upstream: upstream.name,
            endpoint: 'chat/completions',
            stream: payload.stream,
            headers: debugHeaders,
            conversationKey: meta.conversationKey,
            promptCacheKey: normalizedPayload.prompt_cache_key,
            ...(meta.tenantName ? {tenantName: meta.tenantName, tenantUsername: meta.tenantUsername} : {})
        }),
        timeout: 300000
    });

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] 上游返回 HTTP ${response.status}${userInfo ? `, ${userInfo}` : ''}: ${errorMsg.slice(0, 300)}`);
        throw new ProviderUpstreamError(`[${upstream.name}]: 上游返回 HTTP ${response.status}: ${errorMsg}`, response.status);
    }

    return response;
}

export async function createResponses(payload, upstream, meta = {}, endpoint = 'responses') {
    const url = buildProtocolAwareUrl(upstream, endpoint);
    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    const userInfo = meta.tenantName && meta.tenantUsername ? `${meta.tenantName}(${meta.tenantUsername})` : '';

    logger.info(
        `[${upstream.name}]: ${url}, model: ${payload.model || 'unknown'}, protocol: responses, proxy: ${proxyMode}, ${userInfo}`
    );

    // 腾讯云文档要求：prompt_cache_key 标识相同上下文的请求，提升缓存复用
    if (meta.conversationKey && !payload.prompt_cache_key) {
        payload.prompt_cache_key = meta.conversationKey;
    }

    // 缓存策略辅助头部
    const extraHeaders = {
        'Content-Type': 'application/json'
    };
    if (meta.sessionId) {
        extraHeaders['X-Session-ID'] = meta.sessionId;
    }

    const debugHeaders = buildBaseHeaders(upstream, extraHeaders);
    const normalizedPayload = normalizeResponsesPayload(payload, {source: 'relay', upstream: upstream.name});

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: extraHeaders,
        body: interceptAndSerialize(normalizedPayload, {
            channel: 'relay',
            model: payload.model,
            upstream: upstream.name,
            endpoint: 'responses',
            stream: payload.stream,
            headers: debugHeaders,
            conversationKey: meta.conversationKey,
            promptCacheKey: normalizedPayload.prompt_cache_key,
            ...(meta.tenantName ? {tenantName: meta.tenantName, tenantUsername: meta.tenantUsername} : {})
        }),
        timeout: 300000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] Responses 上游返回 HTTP ${response.status}${userInfo ? `, ${userInfo}` : ''}: ${errorMsg.slice(0, 300)}`);
        throw new ProviderUpstreamError(`[${upstream.name}]: Responses 上游返回 HTTP ${response.status}: ${errorMsg}`, response.status);
    }

    return response;
}

export async function createResponsesWebSocket(payload, upstream, meta = {}, endpoint = 'responses') {
    const url = buildResponsesWebSocketUrl(upstream, endpoint);
    const rejectUnauthorized = meta.rejectUnauthorized !== false;
    const agent = getProxyAgent(upstream);
    const extraHeaders = {...(meta.headers || {})};
    if (meta.sessionId) extraHeaders['X-Session-ID'] = meta.sessionId;
    const headers = buildResponsesWebSocketHeaders(upstream, extraHeaders);
    const proxyMode = upstream.proxy ? upstream.proxy : 'direct';
    const networkKey = `${url}:${proxyMode}:${rejectUnauthorized ? 'tls-verify' : 'tls-skip'}`;
    const userInfo = meta.tenantName && meta.tenantUsername ? `${meta.tenantName}(${meta.tenantUsername})` : '';

    logger.info(
        `[${upstream.name}]: ${url}, model: ${payload.model || 'unknown'}, protocol: responses_ws, proxy: ${proxyMode}, ${userInfo}`
    );

    // Chat→Responses 转换路径允许 auto-link（连接池自动注入 previous_response_id + 差集截断），
    // 客户端直传 Responses 格式时不做 auto-link（input 由客户端自行管理）
    const autoLink = meta.autoLink !== false && !payload.previous_response_id;
    const skipInputItemLimit = meta.skipInputItemLimit === true;

    const conn = await acquireResponsesWS({
        url,
        headers,
        authKey: upstream.api_key || upstream.name || url,
        agent,
        rejectUnauthorized,
        contextKey: meta.contextKey,
        preferredPreviousResponseId: payload.previous_response_id,
        networkKey
    });

    return {eventStream: sendResponsesWSRequest(conn, {...payload, _autoLink: autoLink, _skipInputItemLimit: skipInputItemLimit}), conn};
}

export function releaseResponsesWebSocketConnection(conn) {
    releaseResponsesWS(conn);
}

export function discardResponsesWebSocketConnection(conn) {
    discardResponsesWS(conn);
}

export async function createAnthropicMessages(payload, upstream, meta = {}, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'messages');
    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    const userInfo = meta.tenantName && meta.tenantUsername ? `${meta.tenantName}(${meta.tenantUsername})` : '';

    logger.info(
        `[${upstream.name}]: ${url}, model: ${payload.model || 'unknown'}, protocol: anthropic, proxy: ${proxyMode}, ${userInfo}`
    );

    const extraHeaders = {
        'Content-Type': 'application/json',
        'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
        ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
    };
    const debugHeaders = buildBaseHeaders(upstream, extraHeaders);

    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: extraHeaders,
        body: interceptAndSerialize(payload, {
            channel: 'relay',
            model: payload.model,
            upstream: upstream.name,
            endpoint: 'messages',
            stream: payload.stream,
            headers: debugHeaders,
            conversationKey: meta.conversationKey,
            promptCacheKey: payload.prompt_cache_key,
            ...(meta.tenantName ? {tenantName: meta.tenantName, tenantUsername: meta.tenantUsername} : {})
        }),
        timeout: 300000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        logger.error(`[${upstream.name}] Anthropic 上游返回 HTTP ${response.status}${userInfo ? `, ${userInfo}` : ''}: ${errorMsg.slice(0, 300)}`);
        throw new ProviderUpstreamError(`[${upstream.name}]: Anthropic 上游返回 HTTP ${response.status}: ${errorMsg}`, response.status);
    }

    return response;
}

export async function createAnthropicCountTokens(payload, upstream, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'messages/count_tokens');
    const response = await requestJson(url, upstream, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
            ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
        },
        body: JSON.stringify(payload),
        timeout: 30000
    });

    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new ProviderUpstreamError(`[${upstream.name}]: count_tokens 失败 HTTP ${response.status}: ${errorMsg}`, response.status);
    }

    return response;
}

// ==================== 获取上游模型列表 ====================

/**
 * 从上游获取模型列表
 *
 * @param {object} upstream - 上游配置
 * @param {string} upstream.base_url - 上游基础 URL
 * @param {string} upstream.api_key - 上游 API Key
 * @param {string} [upstream.proxy] - 代理地址
 * @returns {Promise<object>} 解析后的 /models 响应 JSON
 * @throws {Error} 请求失败或响应无法解析时抛出
 */
export async function getUpstreamModels(upstream, requestHeaders = {}) {
    const url = buildProtocolAwareUrl(upstream, 'models');

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    logger.info(`[${upstream.name}]:GET ${url} proxy=${proxyMode}`);

    const response = await requestJson(url, upstream, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            ...(isAnthropicUpstream(upstream)
                ? {
                      'anthropic-version': requestHeaders['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION,
                      ...(requestHeaders['anthropic-beta'] ? {'anthropic-beta': requestHeaders['anthropic-beta']} : {})
                  }
                : {})
        },
        timeout: 15000
    });

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new ProviderUpstreamError(`[${upstream.name}]:获取模型列表失败 HTTP ${response.status}: ${errorMsg}`, response.status);
    }

    const body = await readBody(response.body);
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`[${upstream.name}]:模型列表响应 JSON 解析失败: ${e.message}`);
    }
}
