/**
 * HTTP 服务器核心逻辑
 * @module server
 */

import http from 'http';
import {readFileSync, existsSync, mkdirSync, createWriteStream} from 'fs';
import {join, dirname, extname} from 'path';
import {fileURLToPath} from 'url';
import {WebSocketServer} from 'ws';
import logger from './utils/logger.js';
import {routeCodebuddyRequest, handleCodebuddyResponsesWS} from './routes/codebuddy.js';
import {routeRelayRequest, handleRelayResponsesWS} from './routes/relay.js';
import {routeCopilotRequest, handleCopilotResponsesWS} from './routes/copilot.js';
import {routeAdminFrontend} from './routes/dashboard-frontend.js';
import {DASHBOARD_ENTRY_PATH, routeAuthRequest} from './routes/auth.js';
import {routeStatsRequest} from './routes/stats.js';
import {handleFeedback} from './routes/feedback.js';
import {routeFeedbackAdmin} from './routes/feedback-admin.js';
import {sendNotFoundPage, wantsHtml} from './routes/not-found.js';
import Busboy from 'busboy';
import {verifyInternalRequest, handleSyncNotification} from './services/shared/cluster-broadcaster.js';
import {authenticateApiKey} from './services/gateway/gateway-auth.js';
import {requireApiAuth} from './services/gateway/dashboard-auth.js';
import {getSessionUser} from './services/gateway/session.js';
import {unifiedTenantManager} from './services/gateway/tenant-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '..', 'public');
const CODING_PROTOCOL_PREFIX = '/coding';
const API_PREFIX = '/api';
const API_CODING_PROTOCOL_PREFIX = '/api/coding';
const PROTOCOL_ROUTE_PREFIXES = ['/relay', '/codebuddy', '/copilot'];

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
 * 解析请求体为 JSON
 * @param {import('http').IncomingMessage} req - HTTP 请求对象
 * @returns {Promise<any>}
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
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

        // 内部集群同步（多进程广播通知）
        if (req.method === 'POST' && req.url === '/internal/sync') {
            if (!verifyInternalRequest(req)) {
                sendError(res, 403, 'Forbidden');
                return;
            }
            try {
                const payload = await parseBody(req);
                await handleSyncNotification(payload);
                sendJson(res, 200, {ok: true});
            } catch (err) {
                logger.error('Internal sync error:', err);
                sendError(res, 500, 'Internal sync error');
            }
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
        if (req.url.startsWith('/relayFE') || req.url.startsWith('/codebuddyFE') || req.url.startsWith('/copilotFE')) {
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

        // Copilot 路由
        if (req.url.startsWith('/copilot')) {
            try {
                if (!requireApiAuth(req, res, unifiedTenantManager, 'copilot')) return;
                await routeCopilotRequest(req, res);
                return;
            } catch (err) {
                logger.error('Copilot route error:', err);
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

        // 文件上传页面
        if (req.method === 'GET' && req.url === '/uploadFE') {
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>文件上传</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 480px; width: 100%; padding: 48px 24px; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { color: #8b949e; margin-bottom: 32px; font-size: 0.95rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; }
    .file-input { display: none; }
    .file-label { display: block; width: 100%; padding: 12px 16px; border: 2px dashed #30363d; border-radius: 8px; text-align: center; color: #8b949e; cursor: pointer; transition: border-color 0.2s, color 0.2s; margin-bottom: 16px; }
    .file-label:hover { border-color: #58a6ff; color: #58a6ff; }
    .file-label.has-file { border-color: #3fb950; color: #3fb950; }
    button { width: 100%; padding: 12px 16px; border: none; border-radius: 8px; background: #238636; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #2ea043; }
    button:disabled { background: #30363d; color: #8b949e; cursor: not-allowed; }
    .message { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 0.9rem; display: none; }
    .message.success { display: block; background: #0f2d1f; color: #3fb950; border: 1px solid #3fb95044; }
    .message.error { display: block; background: #2d0f0f; color: #f85149; border: 1px solid #f8514944; }
  </style>
</head>
<body>
  <div class="container">
    <h1>文件上传</h1>
    <p class="subtitle">选择文件并上传到服务器</p>
    <div class="card">
      <input type="file" id="fileInput" class="file-input">
      <label for="fileInput" class="file-label" id="fileLabel">点击选择文件</label>
      <button id="uploadBtn" disabled>上传</button>
      <div class="message" id="message"></div>
    </div>
  </div>
  <script>
    function pageApiOrigin(){
      return '';
    }
    function apiUrl(path){
      if(/^https?:\/\//i.test(path))return path;
      const origin=pageApiOrigin();
      return origin?origin+path:path;
    }
    const fileInput = document.getElementById('fileInput');
    const fileLabel = document.getElementById('fileLabel');
    const uploadBtn = document.getElementById('uploadBtn');
    const message = document.getElementById('message');
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        fileLabel.textContent = fileInput.files[0].name;
        fileLabel.classList.add('has-file');
        uploadBtn.disabled = false;
      } else {
        fileLabel.textContent = '点击选择文件';
        fileLabel.classList.remove('has-file');
        uploadBtn.disabled = true;
      }
      message.className = 'message';
    });
    uploadBtn.addEventListener('click', async () => {
      if (fileInput.files.length === 0) return;
      uploadBtn.disabled = true;
      message.className = 'message';
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      try {
        const res = await fetch(apiUrl('/api/upload'), { method: 'POST', credentials: 'include', body: formData });
        const data = await res.json();
        if (data.success) {
          message.className = 'message success';
          message.textContent = '上传成功：' + data.filename;
        } else {
          message.className = 'message error';
          message.textContent = data.message || '上传失败';
        }
      } catch (err) {
        message.className = 'message error';
        message.textContent = '上传失败：' + err.message;
      }
      uploadBtn.disabled = false;
    });
  </script>
</body>
</html>`;
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(html);
            return;
        }

        // 文件上传 API
        if (req.method === 'POST' && req.url === '/api/upload') {
            const contentType = req.headers['content-type'] || '';
            if (!contentType.includes('multipart/form-data')) {
                sendJson(res, 400, {success: false, message: '未找到文件'});
                return;
            }
            try {
                const busboy = Busboy({headers: req.headers});
                let uploadedFile = null;
                let fileWritePromise = null;

                busboy.on('file', (fieldname, file, info) => {
                    // busboy 默认按 latin1 解析文件名，需要转回 UTF-8
                    const filename = Buffer.from(info.filename, 'latin1').toString('utf8');
                    const uploadsDir = join(process.cwd(), 'uploads');
                    if (!existsSync(uploadsDir)) {
                        mkdirSync(uploadsDir);
                    }
                    const savePath = join(uploadsDir, filename);
                    const writeStream = createWriteStream(savePath);
                    file.pipe(writeStream);
                    fileWritePromise = new Promise((resolve, reject) => {
                        writeStream.on('finish', () => resolve(filename));
                        writeStream.on('error', reject);
                        file.on('error', reject);
                    });
                    uploadedFile = filename;
                });

                await new Promise((resolve, reject) => {
                    busboy.on('finish', resolve);
                    busboy.on('error', reject);
                    req.pipe(busboy);
                });

                if (fileWritePromise) {
                    const filename = await fileWritePromise;
                    sendJson(res, 200, {success: true, filename});
                } else {
                    sendJson(res, 400, {success: false, message: '未找到文件'});
                }
            } catch (err) {
                logger.error('Upload error:', err);
                sendJson(res, 500, {success: false, message: '上传处理失败'});
            }
            return;
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
            '/codebuddy/v1/responses': handleCodebuddyResponsesWS,
            '/copilot/v1/responses': handleCopilotResponsesWS
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
