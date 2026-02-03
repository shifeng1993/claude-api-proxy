/**
 * HTTP 服务器核心逻辑
 * @module server
 */

import http from 'http';
import { URL } from 'url';
import { parseRoute } from './router.js';
import { getTransformer } from './transformer/index.js';
import { readBody, request } from './utils/http-client.js';
import { buildUrl } from './utils/helpers.js';
import logger from './utils/logger.js';

/**
 * 解析请求体为 JSON
 * @param {import('http').IncomingMessage} req - HTTP 请求对象
 * @returns {Promise<any>}
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {any} data - 响应数据
 */
function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {string} message - 错误消息
 */
function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(message);
}

/**
 * 健康检查处理
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 */
function handleHealthCheck(res) {
    sendJson(res, 200, {
        status: 'ok',
        timestamp: new Date().toISOString()
    });
}

/**
 * 处理代理请求
 * @param {import('http').IncomingMessage} req - HTTP 请求对象
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 */
async function handleProxyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 解析路由
    const { match, error: routeError } = parseRoute(url.pathname, req.headers);
    if (routeError) {
        sendError(res, routeError.status, routeError.message);
        return;
    }

    // 获取 Transformer
    const transformer = getTransformer(match.type);
    if (!transformer) {
        sendError(res, 400, 'Unsupported type');
        return;
    }

    try {
        // 解析请求体
        const claudeRequest = await parseBody(req);

        // 使用 Transformer 转换请求
        const openaiRequest = transformer.transformRequestOut(claudeRequest);

        // 构建最终 URL
        const finalUrl = buildUrl(match.baseUrl, transformer.endPoint || 'v1/chat/completions');

        // 构建请求头
        const headers = {
            ...match.headers,
            'Authorization': `Bearer ${match.apiKey}`,
            'Content-Type': 'application/json'
        };

        // 移除不需要的头
        delete headers['host'];
        delete headers['content-length'];

        // 发送请求到上游 API
        const upstreamResponse = await request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        });

        // 处理错误响应
        if (upstreamResponse.status >= 400) {
            const errorBody = await readBody(upstreamResponse.body);
            res.writeHead(upstreamResponse.status, {
                'Content-Type': upstreamResponse.headers['content-type'] || 'text/plain'
            });
            res.end(errorBody);
            return;
        }

        // 判断是否为流式响应
        // 优先使用请求参数 stream，如果请求指定了 stream: true，应该使用流式处理
        // 同时也检查响应头作为备用判断
        const isStreamRequest = claudeRequest.stream === true;
        const isStreamResponseHeader = transformer.isStreamResponse ?
            transformer.isStreamResponse(upstreamResponse.headers) :
            upstreamResponse.headers['content-type']?.includes('text/event-stream');

        if (isStreamRequest || isStreamResponseHeader) {
            // 使用 Transformer 处理流式响应
            if (transformer.handleStreamResponse) {
                await transformer.handleStreamResponse(upstreamResponse.body, res);
            } else {
                // 降级处理：直接传递流
                res.writeHead(upstreamResponse.status, upstreamResponse.headers);
                upstreamResponse.body.pipe(res);
            }
        } else {
            // 非流式响应：读取响应体，转换格式后返回
            const responseBody = await readBody(upstreamResponse.body);
            const openaiData = JSON.parse(responseBody);
            const claudeResponse = transformer.transformResponseIn(openaiData);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(claudeResponse));
        }
    } catch (err) {
        logger.error('Proxy request error:', err);
        sendError(res, 500, 'Internal server error');
    }
}

/**
 * 创建 HTTP 服务器
 * @returns {import('http').Server}
 */
export function createServer() {
    return http.createServer(async (req, res) => {
        logger.info(`${req.method} ${req.url}`);

        // 健康检查
        if (req.method === 'GET' && req.url === '/health') {
            handleHealthCheck(res);
            return;
        }

        // 根路径欢迎信息
        if (req.method === 'GET' && req.url === '/') {
            sendJson(res, 200, {
                name: 'Claude API Proxy',
                version: '1.0.0',
                description: 'Proxy service for converting Claude API requests to OpenAI format',
                endpoints: {
                    health: '/health',
                    proxy: '/{type}/{provider_url}/v1/messages'
                }
            });
            return;
        }

        // 只允许 POST 请求
        if (req.method !== 'POST') {
            sendError(res, 405, 'Method not allowed');
            return;
        }

        try {
            await handleProxyRequest(req, res);
        } catch (err) {
            logger.error('Server error:', err);
            sendError(res, 500, 'Internal server error');
        }
    });
}
