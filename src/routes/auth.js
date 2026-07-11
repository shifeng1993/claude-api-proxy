/**
 * 统一登录/登出路由
 * @module routes/auth
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {
    createSessionToken,
    clearSessionCookie,
    getAuthMode,
    getSessionUser,
    ldapAuthenticate,
    localAuthenticate,
    setSessionCookie,
    unifiedTenantManager
} from '../services/gateway/index.js';
import {sendNotFoundPage, wantsHtml} from './not-found.js';
import logger from '../utils/logger.js';
import {readJsonBody} from '../utils/helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGIN_PAGE = readFileSync(join(__dirname, '..', 'templates', 'login.html'), 'utf8');
export const DASHBOARD_ENTRY_PATH = '/dashboard#/relay';

function currentAuthMode() {
    try {
        return getAuthMode();
    } catch {
        return 'local';
    }
}

function renderLoginPage() {
    const authMode = currentAuthMode();
    return LOGIN_PAGE
        .replace('{{LOGIN_SUBTITLE}}', authMode === 'ldap'
            ? '使用 LDAP 域账号或本地账号登录。'
            : '使用管理员派发的本地账号登录。')
        .replace('{{AUTH_MODE_HINT}}', authMode === 'ldap'
            ? '当前是LDAP认证模式'
            : '当前是本地账号认证模式');
}

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

export async function resolveLoginRole({authMode, username, displayName, resultRole, tenantManager = unifiedTenantManager}) {
    if (authMode !== 'ldap') return resultRole || 'user';

    const tenantId = await tenantManager.createTenantForUser(username, displayName || username);
    const tenant = tenantManager.getTenant(tenantId);
    return tenant?.role || resultRole || 'user';
}

function readBody(req) {
    return readJsonBody(req, {maxBytes: 1024 * 1024});
}

export async function routeAuthRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;
    const isLoginPath = pathname === '/login' || pathname === '/login/';

    // GET /login — serve login page
    if (isLoginPath && method === 'GET') {
        if (getSessionUser(req).authenticated) {
            res.writeHead(302, {Location: DASHBOARD_ENTRY_PATH});
            res.end();
            return;
        }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(renderLoginPage());
        return;
    }

    // POST /login — handle login
    if (isLoginPath && method === 'POST') {
        try {
            const {username, password} = await readBody(req);
            if (!username || !password) {
                return sendJson(res, 400, {error: '用户名和密码不能为空'});
            }

            const authMode = getAuthMode();
            const result = authMode === 'ldap'
                ? await ldapAuthenticate(username, password)
                : await localAuthenticate(username, password);

            if (!result.success) {
                return sendJson(res, 401, {error: result.message});
            }

            const role = await resolveLoginRole({
                authMode,
                username: result.username,
                displayName: result.displayName,
                resultRole: result.role
            });
            const token = createSessionToken(result.username, role);
            setSessionCookie(res, token, req);

            return sendJson(res, 200, {
                success: true,
                username: result.username,
                displayName: result.displayName,
                redirect: DASHBOARD_ENTRY_PATH
            });
        } catch (error) {
            logger.error('登录失败:', error);
            return sendJson(res, error.status || 500, {error: error.message});
        }
    }

    // POST /logout — handle logout
    if (pathname === '/logout' && method === 'POST') {
        clearSessionCookie(res, req);
        return sendJson(res, 200, {message: '已退出登录'});
    }

    if (wantsHtml(req)) {
        sendNotFoundPage(req, res);
        return;
    }
    sendJson(res, 404, {error: 'Not found'});
}
