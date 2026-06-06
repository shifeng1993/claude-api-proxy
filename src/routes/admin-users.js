/**
 * 本地账号管理路由处理器
 * 仅在 relay 侧挂载（/relayFE/admin/users）
 * 创建的账号可同时用于 relay 和 codebuddy 两个端点
 * @module routes/admin-users
 */

import logger from '../utils/logger.js';
import {
    listLocalUsers,
    createLocalUser,
    updateLocalUser,
    resetLocalUserPassword,
    deleteLocalUser
} from '../services/shared/local-user-manager.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function userTenant(username) {
    const tenantId = unifiedTenantManager.findTenantByUsername(username);
    if (!tenantId) return null;
    const tenant = unifiedTenantManager.getTenant(tenantId);
    if (!tenant) return null;
    return {
        id: tenant.id,
        name: tenant.name,
        username: tenant.username,
        serviceProfiles: (tenant.serviceProfiles || []).map(profile => ({
            service_type: profile.service_type,
            enabled: profile.enabled,
            total_api_calls: profile.total_api_calls || 0,
            total_input_tokens: profile.total_input_tokens || 0,
            total_output_tokens: profile.total_output_tokens || 0,
            total_cache_hit_tokens: profile.total_cache_hit_tokens || 0
        }))
    };
}

/**
 * 处理 /relayFE/admin/users[/...] 路由
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathSuffix - subPath 部分（去掉 '/admin/users' 前缀的剩余），如 '' 或 '/alice/password'
 * @param {string} currentUsername - 当前登录 admin
 * @returns {Promise<boolean>} 是否处理了请求
 */
export async function handleAdminUsers(req, res, pathSuffix, currentUsername, currentRole = 'admin') {
    const method = req.method;

    try {
        // GET /admin/users — 列表
        if (pathSuffix === '' && method === 'GET') {
            const users = await listLocalUsers(currentRole);
            sendJson(res, 200, {
                users: users.map(user => ({
                    ...user,
                    tenant: userTenant(user.username)
                }))
            });
            return true;
        }

        // POST /admin/users — 创建
        if (pathSuffix === '' && method === 'POST') {
            const body = await readRequestBody(req);
            const result = await createLocalUser(body, currentRole);
            if (!result.ok) {
                sendJson(res, result.status, {error: result.error});
            } else {
                sendJson(res, 200, {
                    message: '账号创建成功',
                    username: result.username,
                    apiKey: result.apiKey
                });
            }
            return true;
        }

        // PUT /admin/users/:username/password — 重置密码
        const pwMatch = pathSuffix.match(/^\/([^/]+)\/password$/);
        if (pwMatch && method === 'PUT') {
            const targetUser = decodeURIComponent(pwMatch[1]);
            const body = await readRequestBody(req);
            const result = await resetLocalUserPassword(targetUser, body.password, currentRole);
            if (!result.ok) {
                sendJson(res, result.status, {error: result.error});
            } else {
                sendJson(res, 200, {message: '密码已重置'});
            }
            return true;
        }

        // PUT /admin/users/:username — edit profile
        const updateMatch = pathSuffix.match(/^\/([^/]+)$/);
        if (updateMatch && method === 'PUT') {
            const targetUser = decodeURIComponent(updateMatch[1]);
            const body = await readRequestBody(req);
            const result = await updateLocalUser(targetUser, body, currentRole);
            if (!result.ok) {
                sendJson(res, result.status, {error: result.error});
            } else {
                sendJson(res, 200, {message: '璐﹀彿宸叉洿鏂?'});
            }
            return true;
        }

        // DELETE /admin/users/:username
        const delMatch = pathSuffix.match(/^\/([^/]+)$/);
        if (delMatch && method === 'DELETE') {
            const targetUser = decodeURIComponent(delMatch[1]);
            const result = await deleteLocalUser(targetUser, currentUsername, currentRole);
            if (!result.ok) {
                sendJson(res, result.status, {error: result.error});
            } else {
                sendJson(res, 200, {message: '账号已删除'});
            }
            return true;
        }

        return false; // 未匹配
    } catch (error) {
        logger.error(`Admin users route error (${method} ${pathSuffix}):`, error);
        sendJson(res, 500, {error: error.message});
        return true;
    }
}
