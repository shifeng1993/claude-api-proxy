/**
 * Relay API 调用模块
 * 向上游 LLM API 发送请求，支持 per-upstream 代理（HTTP/HTTPS/SOCKS5）及 agent 缓存
 * @module services/relay/api
 */

import {request, readBody} from '../../utils/http-client.js';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import {buildUrl} from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

// ==================== 代理 Agent 缓存 ====================

/**
 * 按 proxy URL 缓存的 agent 实例，避免每次请求重复创建
 * @type {Map<string, HttpsProxyAgent|SocksProxyAgent>}
 */
const proxyAgentCache = new Map();

/**
 * 获取代理 Agent（带缓存）
 * - 代理 URL 为空或 falsy 时返回 undefined（直连）
 * - socks5:// / socks4:// 开头使用 SocksProxyAgent
 * - http:// / https:// 开头使用 HttpsProxyAgent
 *
 * @param {string} [proxyUrl] - 代理地址
 * @returns {HttpsProxyAgent|SocksProxyAgent|undefined}
 */
export function getProxyAgent(proxyUrl) {
    if (!proxyUrl) {
        return undefined;
    }

    // 命中缓存
    if (proxyAgentCache.has(proxyUrl)) {
        return proxyAgentCache.get(proxyUrl);
    }

    let agent;
    try {
        if (proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks://')) {
            agent = new SocksProxyAgent(proxyUrl);
        } else if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
            agent = new HttpsProxyAgent(proxyUrl);
        } else {
            logger.warn(`Relay API: 不支持的代理协议 "${proxyUrl}"，将直连`);
            return undefined;
        }

        proxyAgentCache.set(proxyUrl, agent);
        return agent;
    } catch (err) {
        logger.error(`Relay API: 创建代理 Agent 失败 (${proxyUrl}): ${err.message}`);
        return undefined;
    }
}

/**
 * 判断上游是否指向本地 Copilot 端点
 */
function isLocalCopilotUpstream(base_url) {
    try {
        const url = new URL(base_url);
        return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname.includes('/copilot');
    } catch {
        return false;
    }
}

// ==================== Chat Completions ====================

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
    const url = buildUrl(upstream.base_url, 'chat/completions');

    const headers = {
        'Authorization': `Bearer ${upstream.api_key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Relay/1.0'
    };

    // 透传代理到本地 Copilot 端点
    if (isLocalCopilotUpstream(upstream.base_url) && upstream.proxy) {
        headers['X-Copilot-Proxy'] = upstream.proxy;
    }

    const options = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: 300000 // 聊天请求可能较慢，默认 5 分钟
    };

    // 代理配置
    const proxyAgent = getProxyAgent(upstream.proxy);
    if (proxyAgent) {
        options.agent = proxyAgent;
    }

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    const reasoningEffort = payload.reasoning_effort || 'N/A';
    logger.info(`Relay API: [${upstream.name}] model=${payload.model || 'unknown'} proxy=${proxyMode} effort=${reasoningEffort}`);

    const response = await request(url, options);

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new Error(
            `Relay API: [${upstream.name}] 上游返回 HTTP ${response.status}: ${errorMsg}`
        );
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
export async function getUpstreamModels(upstream) {
    const url = buildUrl(upstream.base_url, 'models');

    const headers = {
        'Authorization': `Bearer ${upstream.api_key}`,
        'Accept': 'application/json',
        'User-Agent': 'Relay/1.0'
    };

    // 透传代理到本地 Copilot 端点
    if (isLocalCopilotUpstream(upstream.base_url) && upstream.proxy) {
        headers['X-Copilot-Proxy'] = upstream.proxy;
    }

    const options = {
        method: 'GET',
        headers,
        timeout: 15000
    };

    // 代理配置
    const proxyAgent = getProxyAgent(upstream.proxy);
    if (proxyAgent) {
        options.agent = proxyAgent;
    }

    const proxyMode = upstream.proxy ? upstream.proxy : '直连';
    logger.info(`Relay API: GET ${url} proxy=${proxyMode}`);

    const response = await request(url, options);

    // 非 2xx 时读取响应体并抛出异常
    if (response.status < 200 || response.status >= 300) {
        const errorBody = await readBody(response.body);
        const errorMsg = errorBody.length > 500 ? errorBody.substring(0, 500) + '...' : errorBody;
        throw new Error(
            `Relay API: 获取模型列表失败 HTTP ${response.status}: ${errorMsg}`
        );
    }

    const body = await readBody(response.body);
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`Relay API: 模型列表响应 JSON 解析失败: ${e.message}`);
    }
}
