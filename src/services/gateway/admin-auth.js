/**
 * 鉴权集成层
 * 整合 session、凭证验证、速率限制，提供守卫函数
 * @module services/gateway/admin-auth
 */

import {isAdminAuthEnabled, isGatewayAuthEnabled, verifyAdminCredentials, authenticateGatewayRequest} from './auth.js';
import {rsaKeyManager} from './rsa-keys.js';
import {createSessionToken, verifySessionToken, parseCookies, getCookieName, createSessionCookie, clearSessionCookie, shouldRenewSession} from './session.js';
import {adminRateLimiter, apiRateLimiter} from './rate-limit.js';
import {getLoginHtml} from './login-page.js';
import logger from '../../utils/logger.js';

/**
 * 读取请求体
 * @param {object} req - HTTP 请求对象
 * @returns {Promise<string>}
 */
async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 获取客户端 IP
 * @param {object} req - HTTP 请求对象
 * @returns {string}
 */
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        'unknown';
}

/**
 * 判断请求是否接受 HTML
 * @param {object} req - HTTP 请求对象
 * @returns {boolean}
 */
function acceptsHtml(req) {
    return (req.headers['accept'] || '').includes('text/html');
}

/**
 * 判断是否为 HTTPS
 * @param {object} req - HTTP 请求对象
 * @returns {boolean}
 */
function isSecure(req) {
    return req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 处理登录页面请求 GET /login
 */
export function serveLoginPage(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const returnUrl = url.searchParams.get('return') || '/';


    // 已登录用户重定向到目标页
    const cookies = parseCookies(req);
    const sessionToken = cookies.get(getCookieName());
    if (sessionToken) {
        const result = verifySessionToken(sessionToken);
        if (result.valid) {
            res.writeHead(302, {'Location': returnUrl});
            res.end();
            return;
        }
    }

    const publicKey = rsaKeyManager.getPublicKey();
    const html = getLoginHtml(returnUrl, publicKey);
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * 获取公钥端点 GET /login/public-key
 */
export function getPublicKeyEndpoint(req, res) {
    const publicKey = rsaKeyManager.getPublicKey();
    sendJson(res, 200, {public_key: publicKey});
}

/**
 * 处理登录请求 POST /login
 */
export async function handleLoginRequest(req, res) {
    const clientIp = getClientIp(req);

    // 速率限制检查
    const rateCheck = adminRateLimiter.checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': Math.ceil(rateCheck.retryAfterMs / 1000)
        });
        res.end(JSON.stringify({
            error: 'Too many authentication failures',
            retry_after: Math.ceil(rateCheck.retryAfterMs / 1000)
        }));
        return;
    }

    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);
        const {username, encrypted_password, return_url} = data;

        if (!username || !encrypted_password) {
            adminRateLimiter.recordFailure(clientIp);
            sendJson(res, 401, {error: 'Username and password are required'});
            return;
        }

        // 验证凭证（支持加密密码和明文密码）
        const result = verifyAdminCredentials(username, encrypted_password);
        if (!result.valid) {
            adminRateLimiter.recordFailure(clientIp);
            sendJson(res, 401, {error: result.error});
            return;
        }

        // 登录成功
        adminRateLimiter.recordSuccess(clientIp);

        // 创建 session
        const token = createSessionToken(username);
        const secure = isSecure(req);
        const cookieHeader = createSessionCookie(token, secure);

        const redirectUrl = return_url || '/';
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieHeader
        });
        res.end(JSON.stringify({success: true, redirect: redirectUrl}));
    } catch (err) {
        logger.error('Login request error:', err.message);
        adminRateLimiter.recordFailure(clientIp);
        sendJson(res, 400, {error: 'Invalid request'});
    }
}

/**
 * 处理登出请求 GET/POST /logout
 */
export function handleLogoutRequest(req, res) {
    const cookieHeader = clearSessionCookie();
    res.writeHead(302, {
        'Set-Cookie': cookieHeader,
        'Location': '/login'
    });
    res.end();
}

/**
 * 管理后台鉴权守卫
 * @param {object} req - HTTP 请求对象
 * @param {object} res - HTTP 响应对象
 * @returns {boolean} true=通过，false=已拦截（已发送响应）
 */
export function requireAdminAuth(req, res) {
    // 未启用管理后台认证，直接通过
    if (!isAdminAuthEnabled()) {
        return true;
    }

    // 检查 session cookie
    const cookies = parseCookies(req);
    const sessionToken = cookies.get(getCookieName());

    if (sessionToken) {
        const result = verifySessionToken(sessionToken);
        if (result.valid) {
            // session 有效，检查是否需要续期
            if (shouldRenewSession(sessionToken)) {
                const newToken = createSessionToken(result.username);
                const secure = isSecure(req);
                res.setHeader('Set-Cookie', createSessionCookie(newToken, secure));
            }
            return true;
        }
    }

    // 未认证
    const clientIp = getClientIp(req);

    // 速率限制检查
    const rateCheck = adminRateLimiter.checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
        if (acceptsHtml(req)) {
            res.writeHead(429, {'Content-Type': 'text/html; charset=utf-8'});
            res.end('<h1>429 Too Many Requests</h1><p>Please try again later.</p>');
        } else {
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': Math.ceil(rateCheck.retryAfterMs / 1000)
            });
            res.end(JSON.stringify({
                error: 'Too many authentication failures',
                retry_after: Math.ceil(rateCheck.retryAfterMs / 1000)
            }));
        }
        return false;
    }

    // 重定向到登录页面或返回 401
    if (acceptsHtml(req)) {
        const returnUrl = encodeURIComponent(req.url);
        res.writeHead(302, {'Location': `/login?return=${returnUrl}`});
        res.end();
    } else {
        sendJson(res, 401, {error: 'Authentication required', login_url: '/login'});
    }
    return false;
}

/**
 * API 网关鉴权守卫
 * @param {object} req - HTTP 请求对象
 * @param {object} res - HTTP 响应对象
 * @returns {boolean} true=通过，false=已拦截
 */
export function requireGatewayAuth(req, res) {
    // 未启用网关令牌认证
    if (!isGatewayAuthEnabled()) {
        // 未启用时拒绝所有 API 请求（不再向后兼容旧的各后端 API Key）
        sendGatewayError(res, req.url, 401, 'Gateway token not configured. Set GATEWAY_TOKEN environment variable.');
        return false;
    }

    const clientIp = getClientIp(req);

    // 速率限制检查
    const rateCheck = apiRateLimiter.checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': Math.ceil(rateCheck.retryAfterMs / 1000)
        });
        res.end(JSON.stringify({
            error: {message: 'Too many authentication failures', type: 'rate_limit_error', code: 429},
            retry_after: Math.ceil(rateCheck.retryAfterMs / 1000)
        }));
        return false;
    }

    // 验证网关令牌
    const result = authenticateGatewayRequest(req.headers);
    if (!result.authenticated) {
        apiRateLimiter.recordFailure(clientIp);
        sendGatewayError(res, req.url, 401, result.error);
        return false;
    }

    // 认证成功，标记请求
    req._gatewayAuthenticated = true;
    apiRateLimiter.recordSuccess(clientIp);
    return true;
}

/**
 * 根据请求路径格式发送网关错误
 * /anthropic/ 路径使用 Anthropic 格式，其他使用 OpenAI 格式
 */
function sendGatewayError(res, url, status, message) {
    if (url && url.includes('/anthropic/')) {
        // Anthropic 格式错误
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            type: 'error',
            error: {
                type: 'authentication_error',
                message: message
            }
        }));
    } else {
        // OpenAI 格式错误
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            error: {
                message: message,
                type: 'authentication_error',
                code: status
            }
        }));
    }
}
