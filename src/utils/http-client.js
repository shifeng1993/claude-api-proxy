/**
 * HTTP 客户端封装模块
 * 使用 Node.js 原生 http/https 模块
 * @module utils/http-client
 */

import https from 'https';
import http from 'http';
import {URL} from 'url';
import {createGunzip, createInflate} from 'zlib';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import logger from './logger.js';

/**
 * 发送 HTTP 请求
 * @param {string} url - 请求 URL
 * @param {object} options - 请求选项
 * @param {string} options.method - HTTP 方法
 * @param {object} options.headers - 请求头
 * @param {string} [options.body] - 请求体
 * @returns {Promise<{status: number, headers: object, body: import('stream').Readable}>}
 */
export function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            logger.error(`无效的 URL: "${url}"`);
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }

        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        // 准备请求头，明确禁用压缩以避免解压问题
        const headers = {...options.headers};

        // 代理配置
        let agent = null;
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
        
        if (proxyUrl) {
            try {
                if (proxyUrl.startsWith('socks')) {
                    agent = new SocksProxyAgent(proxyUrl);
                    logger.debug(`使用 SOCKS 代理: ${proxyUrl}`);
                } else {
                    agent = new HttpsProxyAgent(proxyUrl);
                    logger.debug(`使用 HTTP 代理: ${proxyUrl}`);
                }
            } catch (err) {
                logger.warn(`代理配置失败: ${err.message}`);
            }
        }

        // 只有当用户没有设置 Accept-Encoding 时才设置默认值
        let hasAcceptEncoding = false;
        for (const key in headers) {
            if (key.toLowerCase() === 'accept-encoding') {
                hasAcceptEncoding = true;
                break;
            }
        }
        if (!hasAcceptEncoding) {
            headers['Accept-Encoding'] = 'identity';
        }

        const requestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers,
            agent: agent || undefined
        };

        logger.debug(`发送请求: ${options.method || 'GET'} ${url}`);

        const req = protocol.request(requestOptions, (res) => {
            logger.debug(`响应状态: ${res.statusCode}`);
            logger.debug(`响应类型: ${res.headers['content-type'] || 'unknown'}`);

            // 自动处理 gzip/deflate 压缩（大小写不敏感）
            let responseBody = res;
            // 获取 content-encoding 头（大小写不敏感）
            const contentEncoding = Object.keys(res.headers).find((key) => key.toLowerCase() === 'content-encoding');
            const encoding = contentEncoding ? res.headers[contentEncoding] : null;

            if (encoding) {
                logger.debug(`检测到压缩编码: ${encoding}`);
            }

            if (encoding && encoding.toLowerCase().includes('gzip')) {
                logger.debug('正在解压 gzip 数据...');
                responseBody = res.pipe(createGunzip());
                // 移除 content-encoding 头
                delete res.headers[contentEncoding];
            } else if (
                encoding &&
                (encoding.toLowerCase().includes('deflate') || encoding.toLowerCase().includes('br'))
            ) {
                logger.debug(`检测到 ${encoding} 压缩，正在解压...`);
                responseBody = res.pipe(createInflate());
                // 移除 content-encoding 头
                delete res.headers[contentEncoding];
            }

            resolve({
                status: res.statusCode,
                headers: res.headers,
                body: responseBody
            });
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
