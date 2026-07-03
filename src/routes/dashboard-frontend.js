/**
 * 统一管理面板路由
 * @module routes/dashboard-frontend
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import {
    changeOwnLocalUserPassword,
    getDashboardUsageOverview,
    getAuthMode,
    getSessionUser,
    listDashboardTenantMonthlyUsage,
    unifiedTenantManager
} from '../services/gateway/index.js';
import {handleAdminUsers} from './dashboard-users.js';
import {getCodebuddyAdminOptions, handleCodebuddyAdminRoute} from './dashboard-codebuddy.js';
import {getCodebuddyCustomSiteLabels} from '../services/codebuddy/index.js';
import {sendNotFoundPage, wantsHtml} from './not-found.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_PAGE = readFileSync(join(__dirname, '..', 'templates', 'admin.html'), 'utf8');
const SERVICES = new Set(['relay', 'codebuddy']);

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function tenantView(tenant, includePlainKey = false) {
    if (!tenant) return null;
    return {
        id: tenant.id,
        name: tenant.name,
        username: tenant.username,
        role: tenant.role,
        api_key_prefix: tenant.api_key_prefix,
        ...(includePlainKey ? {api_key_plain: tenant.api_key_plain} : {}),
        serviceProfiles: (tenant.serviceProfiles || []).map(profile => ({
            service_type: profile.service_type,
            enabled: profile.enabled,
            total_api_calls: profile.total_api_calls || 0,
            total_input_tokens: profile.total_input_tokens || 0,
            total_output_tokens: profile.total_output_tokens || 0,
            total_cache_hit_tokens: profile.total_cache_hit_tokens || 0,
            total_credit: profile.total_credit || 0
        }))
    };
}

function requireApiSession(req, res) {
    const session = getSessionUser(req);
    if (!session.authenticated) {
        sendJson(res, 401, {error: '登录已过期'});
        return null;
    }
    return session;
}

export async function testRelayUpstream(manager, index) {
    const upstream = manager.listUpstreams()[index];
    const name = upstream?.name || `#${index + 1}`;
    try {
        const result = await manager.testUpstream(index);
        return {index, name, ...result};
    } catch (err) {
        return {index, name, success: false, message: err.message};
    }
}

export function canManageDashboardTenant(actorRole, targetTenant) {
    if (!targetTenant || targetTenant.role === 'superadmin') return false;
    if (actorRole === 'superadmin') return ['admin', 'user'].includes(targetTenant.role || 'user');
    if (actorRole === 'admin') return (targetTenant.role || 'user') === 'user';
    return false;
}

async function adminStatsOverview(req, res, username) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const serviceType = url.searchParams.get('service') || 'relay';
    if (!SERVICES.has(serviceType)) return sendJson(res, 400, {error: 'Invalid service'});

    const result = await getDashboardUsageOverview({
        tenantManager: unifiedTenantManager,
        username,
        serviceType
    });
    if (!result.ok) return sendJson(res, result.status, {error: result.error});
    const {ok, tenant, ...payload} = result;
    return sendJson(res, 200, {
        tenant: tenantView(tenant, false),
        ...payload
    });
}

async function relayOperation(req, res, tenantId, subPath) {
    const manager = await unifiedTenantManager.getUpstreamManager(tenantId);
    if (!manager) {
        sendJson(res, 404, {error: '租户不存在'});
        return true;
    }

    if (subPath === '/upstreams' && req.method === 'GET') {
        sendJson(res, 200, {upstreams: manager.listUpstreams()});
        return true;
    }
    if (subPath === '/upstreams' && req.method === 'POST') {
        const upstream = await manager.addUpstream(await readRequestBody(req));
        sendJson(res, 200, {message: '上游配置已添加', upstream});
        return true;
    }

    const itemMatch = subPath.match(/^\/upstreams\/(\d+)$/);
    if (itemMatch) {
        const index = Number(itemMatch[1]);
        if (req.method === 'PUT') {
            const upstream = await manager.updateUpstream(index, await readRequestBody(req));
            if (!upstream) {
                sendJson(res, 400, {error: '无效的上游索引'});
                return true;
            }
            sendJson(res, 200, {message: '上游配置已更新', upstream});
            return true;
        }
        if (req.method === 'DELETE') {
            const ok = await manager.deleteUpstream(index);
            sendJson(res, ok ? 200 : 400, ok ? {message: '上游已删除'} : {error: '无效的上游索引'});
            return true;
        }
    }

    const cloneMatch = subPath.match(/^\/upstreams\/(\d+)\/clone$/);
    if (cloneMatch && req.method === 'POST') {
        const index = Number(cloneMatch[1]);
        const source = manager.listUpstreams()[index];
        if (!source) {
            sendJson(res, 400, {error: '无效的上游索引'});
            return true;
        }
        const upstream = await manager.addUpstream({
            ...source,
            name: `${source.name || '未命名'} (副本)`,
            api_key: source.api_key_full,
            model_map: {...(source.model_map || {})},
            models: [...(source.models || [])]
        });
        sendJson(res, 200, {message: '上游已复制', upstream});
        return true;
    }

    if (subPath === '/upstreams/set-active' && req.method === 'POST') {
        const {index} = await readRequestBody(req);
        const ok = await manager.setActiveUpstream(Number(index));
        sendJson(res, ok ? 200 : 400, ok ? {message: '活跃上游已切换'} : {error: '该上游无法启用'});
        return true;
    }
    if ((subPath === '/upstreams/move-up' || subPath === '/upstreams/move-down') && req.method === 'POST') {
        const {index} = await readRequestBody(req);
        const ok = subPath.endsWith('move-up')
            ? await manager.moveUp(Number(index))
            : await manager.moveDown(Number(index));
        sendJson(res, ok ? 200 : 400, ok ? {message: '上游顺序已更新'} : {error: '无法继续移动'});
        return true;
    }
    if (subPath === '/upstreams/test' && req.method === 'POST') {
        const {index} = await readRequestBody(req);
        sendJson(res, 200, await testRelayUpstream(manager, Number(index)));
        return true;
    }
    if (subPath === '/upstreams/test-all' && req.method === 'POST') {
        const upstreams = manager.listUpstreams();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        const write = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const total = upstreams.length;
        let done = 0;
        const tasks = upstreams.map((upstream, index) =>
            testRelayUpstream(manager, index).then(entry => {
                done++;
                write('result', entry);
                if (done === total) write('done', {total});
            }).catch(err => {
                done++;
                const entry = {index, name: upstream?.name || `#${index + 1}`, success: false, message: err.message};
                write('result', entry);
                if (done === total) write('done', {total});
            })
        );
        Promise.all(tasks).finally(() => res.end());
        return true;
    }
    return false;
}

export async function routeAdminFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === '/dashboard' || pathname === '/dashboard/') {
        const session = getSessionUser(req);
        if (!session.authenticated) {
            res.writeHead(302, {Location: '/login'});
            res.end();
            return;
        }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(ADMIN_PAGE);
        return;
    }

    const session = requireApiSession(req, res);
    if (!session) return;
    const username = session.username;
    const isAdmin = unifiedTenantManager.isAdmin(username);

    if (pathname === '/dashboard/me' && method === 'GET') {
        const authMode = getAuthMode();
        return sendJson(res, 200, {
            username,
            role: session.role,
            isAdmin,
            isSuperAdmin: session.role === 'superadmin',
            canChangeOwnPassword: authMode !== 'ldap' && username !== process.env.LOCAL_ADMIN_USER
        });
    }

    if (pathname === '/dashboard/me/password' && method === 'PUT') {
        if (getAuthMode() === 'ldap') {
            return sendJson(res, 403, {error: 'LDAP mode does not allow local password changes'});
        }
        const body = await readRequestBody(req);
        const result = await changeOwnLocalUserPassword(username, body.currentPassword, body.newPassword);
        if (!result.ok) return sendJson(res, result.status, {error: result.error});
        return sendJson(res, 200, {message: 'Password changed'});
    }

    if (pathname === '/dashboard/codebuddy/options' && method === 'GET') {
        return sendJson(res, 200, {customSiteLabels: getCodebuddyCustomSiteLabels(), options: getCodebuddyAdminOptions()});
    }

    if (pathname === '/dashboard/stats/overview' && method === 'GET') {
        return adminStatsOverview(req, res, username);
    }

    if (pathname.startsWith('/dashboard/users')) {
        if (!isAdmin) return sendJson(res, 403, {error: '需要管理员权限'});
        const handled = await handleAdminUsers(req, res, pathname.replace('/dashboard/users', ''), username, session.role);
        if (handled) {
            await unifiedTenantManager.reloadRegistry();
            return;
        }
    }

    if (pathname === '/dashboard/tenants' && method === 'GET') {
        const tenants = unifiedTenantManager.listTenants();
        return sendJson(res, 200, {
            tenants: session.role === 'superadmin' ? tenants : tenants.filter(tenant => tenant.username === username)
        });
    }

    if (pathname === '/dashboard/my-tenant' && method === 'GET') {
        let tenantId = unifiedTenantManager.findTenantByUsername(username);
        if (!tenantId) tenantId = await unifiedTenantManager.createTenantForUser(username, username);
        return sendJson(res, 200, {tenant: tenantView(unifiedTenantManager.getTenant(tenantId), true)});
    }

    const tenantMatch = pathname.match(/^\/dashboard\/tenants\/(\d+)(\/.*)?$/);
    if (tenantMatch) {
        const tenantId = Number(tenantMatch[1]);
        const subPath = tenantMatch[2] || '';
        if (!unifiedTenantManager.checkTenantAccess(username, tenantId)) {
            return sendJson(res, 403, {error: '无权访问此租户'});
        }

        if (subPath === '' && method === 'GET') {
            return sendJson(res, 200, {
                tenant: tenantView(unifiedTenantManager.getTenant(tenantId), true)
            });
        }

        if (subPath === '/regenerate-key' && method === 'POST') {
            const result = await unifiedTenantManager.regenerateApiKey(tenantId);
            if (!result) return sendJson(res, 404, {error: '租户不存在'});
            return sendJson(res, 200, {
                message: 'API Key 已重新生成',
                api_key: result.apiKey,
                api_key_prefix: result.apiKeyPrefix
            });
        }

        const serviceMatch = subPath.match(/^\/services\/(relay|codebuddy)$/);
        if (serviceMatch && method === 'PUT') {
            if (!isAdmin) return sendJson(res, 403, {error: '需要管理员权限'});
            if (!canManageDashboardTenant(session.role, unifiedTenantManager.getTenant(tenantId))) {
                return sendJson(res, 403, {error: '无权操作该用户'});
            }
            const {enabled} = await readRequestBody(req);
            const serviceType = serviceMatch[1];
            if (!SERVICES.has(serviceType)) return sendJson(res, 400, {error: '未知服务'});
            await unifiedTenantManager.setServiceEnabled(tenantId, serviceType, enabled === true);
            return sendJson(res, 200, {message: '服务状态已更新'});
        }

        if (subPath === '/stats' && method === 'GET') {
            const serviceType = url.searchParams.get('service') || 'relay';
            const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
            if (!SERVICES.has(serviceType) || !/^\d{4}-\d{2}$/.test(month)) {
                return sendJson(res, 400, {error: 'Invalid service or month'});
            }
            const data = await listDashboardTenantMonthlyUsage({
                tenantManager: unifiedTenantManager,
                tenantId,
                serviceType,
                month
            });
            return sendJson(res, 200, {
                month,
                service: serviceType,
                data
            });
        }

        if (subPath === '/service-profile' && method === 'GET') {
            const serviceType = url.searchParams.get('service') || 'relay';
            if (!SERVICES.has(serviceType)) return sendJson(res, 400, {error: 'Invalid service'});
            await unifiedTenantManager.syncStatsFromDb(tenantId, false);
            const tenant = unifiedTenantManager.getTenant(tenantId);
            const profile = tenant?.serviceProfiles?.find(item => item.service_type === serviceType);
            return sendJson(res, 200, {
                service: serviceType,
                profile: profile ? {
                    service_type: profile.service_type,
                    enabled: profile.enabled,
                    total_api_calls: profile.total_api_calls || 0,
                    total_input_tokens: profile.total_input_tokens || 0,
                    total_output_tokens: profile.total_output_tokens || 0,
                    total_cache_hit_tokens: profile.total_cache_hit_tokens || 0,
                    total_credit: profile.total_credit || 0
                } : null
            });
        }

        if (subPath === '/stats/reset' && method === 'POST') {
            const {service} = await readRequestBody(req);
            if (!SERVICES.has(service)) return sendJson(res, 400, {error: 'Invalid service'});
            await unifiedTenantManager.resetServiceStats(tenantId, service);
            return sendJson(res, 200, {
                message: 'Custom statistics reset',
                tenant: tenantView(unifiedTenantManager.getTenant(tenantId), true)
            });
        }

        const codebuddyHandled = await handleCodebuddyAdminRoute(req, res, tenantId, subPath);
        if (codebuddyHandled) return;

        const relayHandled = await relayOperation(req, res, tenantId, subPath);
        if (relayHandled) return;

    }

    if (wantsHtml(req)) {
        sendNotFoundPage(req, res);
        return;
    }
    sendJson(res, 404, {error: 'Not found'});
}
