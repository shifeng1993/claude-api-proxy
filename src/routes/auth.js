/**
 * 统一登录/登出路由
 * @module routes/auth
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {getAuthMode} from '../services/shared/auth-mode.js';
import {localAuthenticate} from '../services/shared/local-auth.js';
import {ldapAuthenticate} from '../services/codebuddy/ldap-auth.js';
import {
    createSessionToken,
    setSessionCookie,
    clearSessionCookie,
    getSessionUser
} from '../services/gateway/session.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {sendNotFoundPage, wantsHtml} from './not-found.js';
import logger from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGIN_PAGE = readFileSync(join(__dirname, '..', 'templates', 'login.html'), 'utf8');

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

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

export async function routeAuthRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;
    const isLoginPath = pathname === '/login' || pathname === '/login/';

    // GET /login — serve login page
    if (isLoginPath && method === 'GET') {
        if (getSessionUser(req).authenticated) {
            res.writeHead(302, {Location: '/'});
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

            const token = createSessionToken(result.username, result.role || 'user');
            setSessionCookie(res, token);

            // LDAP auto-provision tenant
            if (authMode === 'ldap') {
                await unifiedTenantManager.createTenantForUser(username, result.displayName || username);
            }

            return sendJson(res, 200, {
                success: true,
                username: result.username,
                displayName: result.displayName,
                redirect: '/'
            });
        } catch (error) {
            logger.error('登录失败:', error);
            return sendJson(res, 500, {error: error.message});
        }
    }

    // POST /logout — handle logout
    if (pathname === '/logout' && method === 'POST') {
        clearSessionCookie(res);
        return sendJson(res, 200, {message: '已退出登录'});
    }

    if (wantsHtml(req)) {
        sendNotFoundPage(req, res);
        return;
    }
    sendJson(res, 404, {error: 'Not found'});
}
