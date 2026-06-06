/**
 * 统一鉴权守卫中间件
 * @module services/gateway/admin-auth
 */

import {authenticateApiKey} from './gateway-auth.js';
import {getSessionUser} from './session.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function redirect(res, location) {
    res.writeHead(302, {Location: location});
    res.end();
}

/**
 * API 鉴权守卫 — /relay/*, /codebuddy/*, /copilot/*
 * 成功时注入 req.tenantId
 * @returns {boolean} false = 请求已被响应（鉴权失败），true = 继续处理
 */
export function requireApiAuth(req, res, tenantManager, serviceType) {
    const result = authenticateApiKey(req.headers, tenantManager);

    if (result.error) {
        sendJson(res, result.error.status, {
            error: {
                type: result.error.status === 401 ? 'authentication_error' : 'api_error',
                message: result.error.message
            }
        });
        return false;
    }

    if (result.skipAuth) {
        sendJson(res, 503, {
            error: {type: 'service_unavailable', message: 'Tenant system is not enabled'}
        });
        return false;
    }

    req.tenantId = result.tenantId;
    if (serviceType) {
        const tenant = tenantManager.getTenant(result.tenantId);
        const profile = tenant?.serviceProfiles?.find(item => item.service_type === serviceType);
        if (!profile?.enabled) {
            sendJson(res, 503, {
                error: {
                    type: 'service_unavailable',
                    message: `${serviceType} service is not enabled for this tenant`
                }
            });
            return false;
        }
    }
    return true;
}

/**
 * 管理面板鉴权守卫 — /admin/*
 * 成功时注入 req.sessionUser
 * @returns {boolean}
 */
export function requireAdminAuth(req, res) {
    const session = getSessionUser(req);
    if (!session.authenticated) {
        redirect(res, '/login');
        return false;
    }
    req.sessionUser = session;
    return true;
}

/**
 * Admin 角色检查 — 用于 /admin/users 等路由
 * @returns {boolean}
 */
export function requireAdminRole(req, res) {
    if (!req.sessionUser || !['admin', 'superadmin'].includes(req.sessionUser.role)) {
        sendJson(res, 403, {error: '需要管理员权限'});
        return false;
    }
    return true;
}
