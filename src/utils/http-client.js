/**
 * HTTP 客户端封装模块
 * 使用 Node.js 原生 http/https 模块
 * @module utils/http-client
 */

import https from 'https';
import http from 'http';
import {URL} from 'url';
import {createGunzip, createInflate, createBrotliDecompress} from 'zlib';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import logger from './logger.js';

// 导入重试配置
import {RETRY_CONFIG, HTTP_STATUS, RETRYABLE_ERRORS} from '../config/retry-config.js';

// ==================== 连接池配置 ====================
// 默认连接池参数
const POOL_CONFIG = {
    maxSockets: 100,          // 每个 host 的最大连接数
    maxFreeSockets: 10,       // 每个 host 保持的空闲连接数
    timeout: 60000,           // 连接超时 (60s)
    scheduling: 'fifo'        // FIFO 调度，优先复用最近活跃的连接，减少复用已被远端关闭的连接
};

// 创建全局连接池 agents（复用 TCP 连接）
const globalAgents = {
    http: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,   // 空闲 Keep-Alive 探测间隔 (15s)
        maxSockets: POOL_CONFIG.maxSockets,
        maxFreeSockets: POOL_CONFIG.maxFreeSockets,
        timeout: POOL_CONFIG.timeout,
        scheduling: POOL_CONFIG.scheduling
    }),
    https: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,   // 空闲 Keep-Alive 探测间隔 (15s)
        maxSockets: POOL_CONFIG.maxSockets,
        maxFreeSockets: POOL_CONFIG.maxFreeSockets,
        timeout: POOL_CONFIG.timeout,
        scheduling: POOL_CONFIG.scheduling
    })
};

// 代理 Agent 缓存（按代理 URL 缓存）
const proxyAgentCache = new Map();



// ==================== 重试辅助函数 ====================

/**
 * 计算重试延迟（指数退避 + 抖动）
 * @param {number} attempt - 当前重试次数（从0开始）
 * @param {number} [retryAfterHeader] - Retry-After 响应头的值（秒）
 * @param {number} [maxDelayMs] - 最大延迟上限（毫秒）
 * @returns {number} 延迟时间（毫秒）
 */
function calculateRetryDelay(attempt, retryAfterHeader, maxDelayMs) {
    const maxDelay = maxDelayMs ?? RETRY_CONFIG.MAX_DELAY_MS;

    // 如果有 Retry-After 头，优先使用
    if (retryAfterHeader !== undefined && retryAfterHeader !== null) {
        const delayFromHeader = retryAfterHeader * 1000;
        // 添加小幅抖动（±10%）防止同时重试
        const jitter = delayFromHeader * 0.1 * (Math.random() * 2 - 1);
        return Math.min(delayFromHeader + jitter, maxDelay);
    }

    // 指数退避：baseDelay * 2^attempt
    const baseDelay = RETRY_CONFIG.BASE_DELAY_MS;
    const exponentialDelay = baseDelay * Math.pow(2, attempt);

    // 添加抖动（±25%）防止惊群效应
    const jitterRange = exponentialDelay * RETRY_CONFIG.JITTER_PERCENT;
    const jitter = jitterRange * (Math.random() * 2 - 1);

    // 最终延迟 = 指数延迟 + 抖动，但不超过最大值
    return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * 判断请求是否应该重试
 * @param {number} statusCode - HTTP 状态码
 * @param {boolean} [shouldRetryHeader] - 响应头中是否明确指示重试
 * @returns {boolean} 是否应该重试
 */
function shouldRetryRequest(statusCode, shouldRetryHeader) {
    // 如果响应头明确指示重试，则重试
    if (shouldRetryHeader === true) {
        return true;
    }

    // 检查状态码是否在可重试集合中
    if (HTTP_STATUS.RETRYABLE.has(statusCode)) {
        return true;
    }

    // 5xx 服务器错误（除了已知的特定状态码）通常可重试
    if (statusCode >= 500 && statusCode < 600) {
        return true;
    }

    return false;
}

/**
 * 获取 Retry-After 响应头的值（秒）
 * @param {object} headers - 响应头对象
 * @returns {number|null} Retry-After 值（秒），如果不存在则返回 null
 */
function getRetryAfterHeader(headers) {
    if (!headers || typeof headers !== 'object') {
        return null;
    }

    // 大小写不敏感查找 Retry-After 头
    const headerKeys = Object.keys(headers);
    const retryAfterKey = headerKeys.find(key => key.toLowerCase() === 'retry-after');

    if (!retryAfterKey) {
        return null;
    }

    const value = headers[retryAfterKey];
    if (value === undefined || value === null) {
        return null;
    }

    // 转换为数字
    const numValue = parseInt(String(value), 10);

    // 检查是否为有效的正数
    if (isNaN(numValue) || numValue <= 0) {
        return null;
    }

    return numValue;
}

/**
 * 获取或创建代理 Agent（带缓存）
 */
function getProxyAgent(proxyUrl, isHttps) {
    const cacheKey = `${proxyUrl}:${isHttps ? 'https' : 'http'}`;

    if (proxyAgentCache.has(cacheKey)) {
        return proxyAgentCache.get(cacheKey);
    }

    let agent;
    try {
        if (proxyUrl.startsWith('socks')) {
            agent = new SocksProxyAgent(proxyUrl);
        } else {
            agent = new HttpsProxyAgent(proxyUrl);
        }

        // 设置连接池参数
        agent.maxSockets = POOL_CONFIG.maxSockets;
        agent.maxFreeSockets = POOL_CONFIG.maxFreeSockets;

        proxyAgentCache.set(cacheKey, agent);
        return agent;
    } catch (err) {
        logger.warn(`代理配置失败: ${err.message}`);
        return null;
    }
}

/**
 * 发送 HTTP 请求（内部实现，不含重试）
 */
function requestOnce(url, options = {}) {
    return new Promise((resolve, reject) => {
        const requestStartTime = Date.now();
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            logger.error(`无效的 URL: "${url}"`);
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const protocol = isHttps ? https : http;

        // 准备请求头
        const headers = {...options.headers};

        // 代理配置 - 使用调用方传入的 agent，否则使用全局 agent
        let agent;
        if (options.agent) {
            agent = options.agent;
        } else {
            agent = isHttps ? globalAgents.https : globalAgents.http;
        }

        // 启用压缩以减少传输时间
        let hasAcceptEncoding = false;
        for (const key in headers) {
            if (key.toLowerCase() === 'accept-encoding') {
                hasAcceptEncoding = true;
                break;
            }
        }
        if (!hasAcceptEncoding) {
            headers['Accept-Encoding'] = 'gzip, deflate, br';
        }

        // 超时配置
        const requestTimeout = options.timeout || 120000; // 默认 2 分钟

        const requestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers,
            agent: agent || undefined,
            rejectUnauthorized: 'rejectUnauthorized' in options ? options.rejectUnauthorized : true
        };

        const req = protocol.request(requestOptions, (res) => {
            // 自动处理压缩（大小写不敏感）
            let responseBody = res;
            // 获取 content-encoding 头（大小写不敏感）
            const contentEncodingKey = Object.keys(res.headers).find((key) => key.toLowerCase() === 'content-encoding');
            const encoding = contentEncodingKey ? res.headers[contentEncodingKey] : null;

            if (encoding) {
                const encodingLower = encoding.toLowerCase();

                try {
                    let decompressStream = null;
                    if (encodingLower.includes('br')) {
                        decompressStream = createBrotliDecompress();
                    } else if (encodingLower.includes('gzip')) {
                        decompressStream = createGunzip();
                    } else if (encodingLower.includes('deflate')) {
                        decompressStream = createInflate();
                    }

                    if (decompressStream) {
                        // 监听解压流的错误事件，避免 unhandled error 崩溃进程
                        decompressStream.on('error', (decompressErr) => {
                            logger.warn(`解压流错误: ${decompressErr.message}，回退到原始响应`);
                            // 销毁解压流，防止后续数据继续写入
                            decompressStream.destroy();
                        });
                        responseBody = res.pipe(decompressStream);
                        delete res.headers[contentEncodingKey];
                    }
                } catch (decompressErr) {
                    logger.warn(`解压初始化失败: ${decompressErr.message}`);
                    // 解压失败时继续使用原始响应
                }
            }

            resolve({
                status: res.statusCode,
                headers: res.headers,
                body: responseBody
            });
        });

        // 设置超时
        req.setTimeout(requestTimeout, () => {
            logger.error(`请求超时 (${requestTimeout}ms): ${url}`);
            req.destroy(new Error(`Request timeout after ${requestTimeout}ms`));
        });

        req.on('error', (err) => {
            logger.error(`请求错误: ${err.message}`);
            reject(err);
        });

        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

/**
 * 发送 HTTP 请求（带自动重试，参考 Claude Code 模式）
 * @param {string} url - 请求 URL
 * @param {object} options - 请求选项
 * @param {string} options.method - HTTP 方法
 * @param {object} options.headers - 请求头
 * @param {string} [options.body] - 请求体
 * @param {number} [options.timeout] - 请求超时时间（毫秒），默认 120000
 * @param {number} [options.maxRetries] - 最大重试次数，默认 RETRY_CONFIG.MAX_RETRIES
 * @returns {Promise<{status: number, headers: object, body: import('stream').Readable}>}
 */
export async function request(url, options = {}) {
    const maxRetries = options.maxRetries ?? RETRY_CONFIG.MAX_RETRIES;
    const retryStartTime = Date.now();
    let consecutive529Errors = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 检查总重试时间预算
        const elapsedMs = Date.now() - retryStartTime;
        if (elapsedMs >= RETRY_CONFIG.GIVE_UP_MS) {
            throw new Error(`Retry budget exceeded: spent ${elapsedMs}ms > ${RETRY_CONFIG.GIVE_UP_MS}ms limit`);
        }

        try {
            const response = await requestOnce(url, options);
            const statusCode = response.status;

            // 检查是否需要重试
            const retryAfterHeader = getRetryAfterHeader(response.headers);
            const shouldRetry = shouldRetryRequest(statusCode);

            if (!shouldRetry) {
                return response;
            }

            // 检查是否还有重试机会
            const hasRetriesLeft = attempt < maxRetries;

            // 529 过载错误特殊处理：最多连续重试 3 次
            if (statusCode === 529) {
                consecutive529Errors++;
                if (consecutive529Errors > RETRY_CONFIG.MAX_529_RETRIES) {
                    logger.warn(`529 过载错误重试次数已达上限 (${RETRY_CONFIG.MAX_529_RETRIES} 次)，放弃重试`);
                    return response;
                }
            } else {
                consecutive529Errors = 0; // 非 529 错误重置计数
            }

            if (!hasRetriesLeft) {
                logger.warn(`已达最大重试次数 (${maxRetries})，放弃重试`);
                return response;
            }

            // 计算重试延迟
            const delay = calculateRetryDelay(attempt, retryAfterHeader);

            logger.warn(
                `请求收到 ${statusCode} 状态码，${Math.round(delay)}ms 后重试 ` +
                `(${attempt + 1}/${maxRetries})...`
            );

            await new Promise(resolve => setTimeout(resolve, delay));
            continue;

        } catch (err) {
            // 网络错误处理
            const isRetryableError = RETRYABLE_ERRORS.has(err.code) ||
                err.message?.includes('socket disconnected') ||
                err.message?.includes('ECONNRESET') ||
                err.message?.includes('EPIPE');

            const hasRetriesLeft = attempt < maxRetries;

            if (isRetryableError && hasRetriesLeft) {
                const delay = calculateRetryDelay(attempt);

                logger.warn(
                    `网络错误 (${err.code || err.message})，${Math.round(delay)}ms 后重试 ` +
                    `(${attempt + 1}/${maxRetries})...`
                );

                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            throw err;
        }
    }
}

/**
 * 读取响应体为字符串
 * @param {import('stream').Readable} stream - 可读流
 * @returns {Promise<string>}
 */
export function readBody(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
            // 使用 Buffer.concat 代替字符串拼接，提高大响应体性能
            const buffer = Buffer.concat(chunks);
            resolve(buffer.toString('utf8'));
        });
        stream.on('error', reject);
    });
}

/**
 * 读取响应体为 JSON
 * @param {import('stream').Readable} stream - 可读流
 * @returns {Promise<any>}
 */
export async function readJson(stream) {
    const data = await readBody(stream);

    if (!data || data.trim() === '') {
        logger.error('响应体为空');
        throw new Error('Empty response body - 上游服务返回空响应，可能是 URL 路径错误导致 404');
    }

    try {
        return JSON.parse(data);
    } catch (e) {
        logger.error(`JSON 解析失败，原始数据: "${data.substring(0, 200)}..."`);
        throw new Error(`Invalid JSON response: ${e.message}. Raw data: ${data.substring(0, 100)}`);
    }
}
