/**
 * HTTP 服务器核心逻辑
 * @module server
 */

import http from 'http';
import {readFileSync, existsSync} from 'fs';
import {join, dirname, extname} from 'path';
import {fileURLToPath} from 'url';
import {WebSocketServer} from 'ws';
import logger from './utils/logger.js';
import {routeCodebuddyRequest, handleCodebuddyResponsesWS} from './routes/codebuddy.js';
import {routeRelayRequest, handleRelayResponsesWS} from './routes/relay.js';
import {routeAdminFrontend} from './routes/dashboard-frontend.js';
import {DASHBOARD_ENTRY_PATH, routeAuthRequest} from './routes/auth.js';
import {routeStatsRequest} from './routes/stats.js';
import {handleFeedback} from './routes/feedback.js';
import {routeFeedbackAdmin} from './routes/feedback-admin.js';
import {sendNotFoundPage, wantsHtml} from './routes/not-found.js';
import {
    authenticateApiKey,
    getSessionUser,
    requireApiAuth,
    unifiedTenantManager
} from './services/gateway/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '..', 'public');
const CODING_PROTOCOL_PREFIX = '/coding';
const API_PREFIX = '/api';
const API_CODING_PROTOCOL_PREFIX = '/api/coding';
const PROTOCOL_ROUTE_PREFIXES = ['/relay', '/codebuddy'];

const MIME_TYPES = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function requirePageSession(req, res, adminOnly = false) {
    const session = getSessionUser(req);
    if (!session.authenticated) {
        if (wantsHtml(req)) {
            res.writeHead(302, {Location: '/login'});
            res.end();
        } else {
            sendError(res, 401, 'Authentication required');
        }
        return false;
    }
    if (adminOnly && session.role !== 'admin' && !unifiedTenantManager.isAdmin(session.username)) {
        sendError(res, 403, 'Administrator access required');
        return false;
    }
    req.sessionUser = session;
    return true;
}

/**
 * 发送 JSON 响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {any} data - 响应数据
 */
function sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送错误响应
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} status - HTTP 状态码
 * @param {string} message - 错误消息
 */
function sendError(res, status, message) {
    if (res.headersSent) {
        try { res.end(); } catch {}
        return;
    }
    res.writeHead(status, {'Content-Type': 'text/plain'});
    res.end(message);
}

function configuredCorsOrigins() {
    return (process.env.DASHBOARD_CORS_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function isAllowedCorsOrigin(origin) {
    if (!origin) return false;
    if (configuredCorsOrigins().includes(origin)) return true;
    try {
        const url = new URL(origin);
        return url.protocol === 'https:' && (
            url.hostname === 'shifeng1993.com' ||
            url.hostname.endsWith('.shifeng1993.com')
        );
    } catch {
        return false;
    }
}

function applyCorsHeaders(req, res) {
    const origin = req.headers.origin;
    if (!isAllowedCorsOrigin(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] || 'Content-Type, Authorization, X-API-Key'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    return true;
}

function withSearch(pathname, search) {
    return `${pathname}${search || ''}`;
}

function normalizeApiNamespacePath(pathname) {
    if (pathname === '/api/login' || pathname.startsWith('/api/login/')) {
        return pathname.slice(API_PREFIX.length) || '/login';
    }
    if (pathname === '/api/logout' || pathname.startsWith('/api/logout/')) {
        return pathname.slice(API_PREFIX.length) || '/logout';
    }
    if (pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/')) {
        return pathname.slice(API_PREFIX.length) || '/dashboard';
    }
    if (pathname === '/api/usage') return '/stats/api/overview';
    if (pathname.startsWith('/api/usage/')) {
        const usagePath = pathname.slice('/api/usage'.length);
        if (usagePath === '/api' || usagePath.startsWith('/api/')) {
            return `/stats${usagePath}`;
        }
        return `/stats/api${usagePath}`;
    }
    if (pathname === '/api/stats') return '/stats/api/overview';
    if (pathname.startsWith('/api/stats/')) {
        const statsPath = pathname.slice('/api/stats'.length);
        if (statsPath === '/api' || statsPath.startsWith('/api/')) {
            return `/stats${statsPath}`;
        }
        return `/stats/api${statsPath}`;
    }
    return pathname;
}

function normalizeRequestUrl(req) {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        return req.url || '';
    }
    let pathname = url.pathname;

    const protocolPrefix = pathname.startsWith(`${API_CODING_PROTOCOL_PREFIX}/`)
        ? API_CODING_PROTOCOL_PREFIX
        : pathname.startsWith(`${CODING_PROTOCOL_PREFIX}/`)
            ? CODING_PROTOCOL_PREFIX
            : '';
    if (!protocolPrefix) {
        const normalizedPath = normalizeApiNamespacePath(pathname);
        req.url = withSearch(normalizedPath, url.search);
        return normalizedPath;
    }

    const strippedPath = pathname.slice(protocolPrefix.length);
    const isProtocolPath = PROTOCOL_ROUTE_PREFIXES.some(
        prefix => strippedPath === prefix || strippedPath.startsWith(`${prefix}/`)
    );
    if (!isProtocolPath) {
        req.url = withSearch(pathname, url.search);
        return pathname;
    }
    req.url = withSearch(strippedPath, url.search);
    return strippedPath;
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
 * 创建 HTTP 服务器
 * @returns {import('http').Server}
 */
export function createServer() {
    const server = http.createServer(async (req, res) => {
        const corsApplied = applyCorsHeaders(req, res);
        if (req.method === 'OPTIONS' && corsApplied) {
            res.writeHead(204);
            res.end();
            return;
        }
        normalizeRequestUrl(req);

        // 静态文件服务
        if (req.method === 'GET' && req.url.startsWith('/public/')) {
            try {
                const filePath = join(publicDir, req.url.slice('/public/'.length));
                if (existsSync(filePath)) {
                    const ext = extname(filePath);
                    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                    res.writeHead(200, {
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=86400'
                    });
                    res.end(readFileSync(filePath));
                    return;
                }
            } catch (err) {
                logger.error('Static file serve error:', err);
            }
            if (wantsHtml(req)) sendNotFoundPage(req, res);
            else sendError(res, 404, 'Not found');
            return;
        }

        // 健康检查
        if (req.method === 'GET' && req.url === '/health') {
            handleHealthCheck(res);
            return;
        }

        // ========== 统一认证路由（登录/登出）==========
        if (req.url.startsWith('/login') || (req.url.startsWith('/logout'))) {
            try {
                await routeAuthRequest(req, res);
                return;
            } catch (err) {
                logger.error('Auth route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // ========== 统一管理面板 ==========
        if (req.url.startsWith('/dashboard')) {
            try {
                await routeAdminFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Admin frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 旧管理面板路径重定向
        if (req.url.startsWith('/relayFE') || req.url.startsWith('/codebuddyFE')) {
            res.writeHead(301, {'Location': '/dashboard'});
            res.end();
            return;
        }

        // Relay 路由
        if (req.url.startsWith('/relay')) {
            try {
                if (!requireApiAuth(req, res, unifiedTenantManager, 'relay')) return;
                await routeRelayRequest(req, res);
                return;
            } catch (err) {
                logger.error('Relay route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 反馈问题管理页面及管理 API
        if (req.url.startsWith('/feedback') || req.url.startsWith('/api/feedback/')) {
            try {
                if (!requirePageSession(req, res, false)) return;
                const handled = await routeFeedbackAdmin(req, res);
                if (handled) return;
            } catch (err) {
                logger.error('Feedback admin route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 问题反馈提交 API（精确匹配 /api/feedback，不含子路径）
        if (req.url === '/api/feedback') {
            try {
                if (!requirePageSession(req, res, false)) return;
                const handled = await handleFeedback(req, res);
                if (handled) return;
            } catch (err) {
                logger.error('Feedback route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Stats 统计页面
        if (new URL(req.url, `http://${req.headers.host}`).pathname.startsWith('/stats/api/')) {
            try {
                if (!requirePageSession(req, res, false)) return;
                const handled = await routeStatsRequest(req, res);
                if (handled) return;
            } catch (err) {
                logger.error('Stats route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }
        // CodeBuddy 路由
        if (req.url.startsWith('/codebuddy')) {
            try {
                if (!requireApiAuth(req, res, unifiedTenantManager, 'codebuddy')) return;
                await routeCodebuddyRequest(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 根路径统一进入管理控制台；未登录时先进入登录页
        if (req.method === 'GET' && new URL(req.url, `http://${req.headers.host}`).pathname === '/') {
            const location = getSessionUser(req).authenticated ? DASHBOARD_ENTRY_PATH : '/login';
            res.writeHead(302, {Location: location});
            res.end();
            return;
        }

        // 未匹配的浏览器页面统一显示 404；非页面请求保持原有错误格式
        if (wantsHtml(req)) {
            sendNotFoundPage(req, res);
            return;
        }

        sendError(res, 404, 'Not found');
    });

    // ========== WebSocket 升级路由 ==========
    const wss = new WebSocketServer({noServer: true});

    server.on('upgrade', (req, socket, head) => {
        let pathname;
        try {
            pathname = normalizeRequestUrl(req);
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        const wsRoutes = {
            '/relay/v1/responses': handleRelayResponsesWS,
            '/codebuddy/v1/responses': handleCodebuddyResponsesWS
        };

        const handler = wsRoutes[pathname];
        if (!handler) {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        const authResult = authenticateApiKey(req.headers, unifiedTenantManager);

        if (authResult.error) {
            const status = authResult.error.status === 401 ? '401 Unauthorized' : `${authResult.error.status} Error`;
            socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
            socket.destroy();
            return;
        }

        if (authResult.skipAuth) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
        }

        req.tenantId = authResult.tenantId;
        const serviceType = pathname.split('/')[1];
        const tenant = unifiedTenantManager.getTenant(req.tenantId);
        const profile = tenant?.serviceProfiles?.find(item => item.service_type === serviceType);
        if (!profile?.enabled) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            try {
                Promise.resolve(handler(ws, req)).catch((err) => {
                    logger.error(`WS upgrade handler error for ${pathname}:`, err);
                    try { ws.close(1011, 'Internal error'); } catch {}
                });
            } catch (err) {
                logger.error(`WS upgrade handler error for ${pathname}:`, err);
                try { ws.close(1011, 'Internal error'); } catch {}
            }
        });
    });

    return server;
}
