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
import { routeCopilotRequest } from './routes/copilot.js';
import { routeCodebuddyRequest } from './routes/codebuddy.js';
import { routeCodebuddyFrontend } from './routes/codebuddy-frontend.js';
import { routeRelayRequest } from './routes/relay.js';
import { routeRelayFrontend } from './routes/relay-frontend.js';

/**
 * 解析请求体为 JSON
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

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(message);
}

function handleHealthCheck(res) {
    sendJson(res, 200, {
        status: 'ok',
        timestamp: new Date().toISOString()
    });
}

async function handleProxyRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const { match, error: routeError } = parseRoute(url.pathname, req.headers);
    if (routeError) {
        sendError(res, routeError.status, routeError.message);
        return;
    }

    const transformer = getTransformer(match.type);
    if (!transformer) {
        sendError(res, 400, 'Unsupported type');
        return;
    }

    try {
        const claudeRequest = await parseBody(req);

        const openaiRequest = transformer.transformRequestOut(claudeRequest);

        const finalUrl = buildUrl(match.baseUrl, transformer.endPoint || 'v1/chat/completions');

        const headers = {
            ...match.headers,
            'Authorization': `Bearer ${match.apiKey}`,
            'Content-Type': 'application/json'
        };

        delete headers['host'];
        delete headers['content-length'];

        const upstreamResponse = await request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest)
        });

        if (upstreamResponse.status >= 400) {
            const errorBody = await readBody(upstreamResponse.body);
            res.writeHead(upstreamResponse.status, {
                'Content-Type': upstreamResponse.headers['content-type'] || 'text/plain'
            });
            res.end(errorBody);
            return;
        }

        const isStreamRequest = claudeRequest.stream === true;
        const isStreamResponseHeader = transformer.isStreamResponse ?
            transformer.isStreamResponse(upstreamResponse.headers) :
            upstreamResponse.headers['content-type']?.includes('text/event-stream');

        if (isStreamRequest || isStreamResponseHeader) {
            if (transformer.handleStreamResponse) {
                await transformer.handleStreamResponse(upstreamResponse.body, res);
            } else {
                res.writeHead(upstreamResponse.status, upstreamResponse.headers);
                upstreamResponse.body.pipe(res);
            }
        } else {
            const responseBody = await readBody(upstreamResponse.body);
            let openaiData;
            try {
                openaiData = JSON.parse(responseBody);
            } catch (parseErr) {
                logger.error(`上游响应 JSON 解析失败，原始数据: "${responseBody.substring(0, 300)}"`);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'api_error',
                        message: `上游返回非法 JSON: ${parseErr.message}`
                    }
                }));
                return;
            }
            const claudeResponse = transformer.transformResponseIn(openaiData);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(claudeResponse));
        }
    } catch (err) {
        logger.error('Proxy request error:', err);
        sendError(res, 500, 'Internal server error');
    }
}

export function createServer() {
    return http.createServer(async (req, res) => {
        // 只打印已知路由的请求日志，忽略遥测等无关请求
        const isKnown = req.url === '/health' ||
            req.url.startsWith('/copilot') ||
            req.url.startsWith('/codebuddyFE') ||
            req.url.startsWith('/codebuddy/v1/') ||
            req.url.startsWith('/codebuddy/anthropic/v1/') ||
            req.url.startsWith('/relayFE') ||
            req.url.startsWith('/relay/v1/') ||
            req.url.startsWith('/relay/anthropic/v1/') ||
            req.url.endsWith('/v1/messages') ||
            req.url.endsWith('/v1/messages/count_tokens');
        if (isKnown) {
            logger.info(`${req.method} ${req.url}`);
        }

        // 健康检查
        if (req.method === 'GET' && req.url === '/health') {
            handleHealthCheck(res);
            return;
        }

        // Copilot 路由
        if (req.url.startsWith('/copilot')) {
            try {
                await routeCopilotRequest(req, res);
                return;
            } catch (err) {
                logger.error('Copilot route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 前端管理界面
        if (req.url.startsWith('/relayFE')) {
            try {
                await routeRelayFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Relay frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 路由
        if (req.url.startsWith('/relay')) {
            try {
                await routeRelayRequest(req, res);
                return;
            } catch (err) {
                logger.error('Relay route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 前端管理界面
        if (req.url.startsWith('/codebuddyFE')) {
            try {
                await routeCodebuddyFrontend(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 路由
        if (req.url.startsWith('/codebuddy')) {
            try {
                await routeCodebuddyRequest(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 根路径欢迎信息
        if (req.method === 'GET' && req.url === '/') {
            sendJson(res, 200, {
                name: 'Claude API Proxy',
                version: '1.0.0',
                description: 'Proxy service for converting Claude API requests to OpenAI format',
                endpoints: {
                    health: '/health',
                    copilot: '/copilot - GitHub Copilot API proxy',
                    codebuddy: '/codebuddy - CodeBuddy API proxy',
                    codebuddyFE: '/codebuddyFE - CodeBuddy Web Admin UI',
                    relay: '/relay - LLM API Relay proxy',
                    relayFE: '/relayFE - Relay Web Admin UI',
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
