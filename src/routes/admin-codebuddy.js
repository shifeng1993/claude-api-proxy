import {randomBytes, randomUUID} from 'crypto';
import logger from '../utils/logger.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {broadcast} from '../services/shared/cluster-broadcaster.js';
import {
    BLOCKED_DOMAINS,
    getCodebuddyBaseUrl,
    getCodebuddyCustomSiteLabel,
    getExtraBaseUrls,
    getModelsForHost,
    isPersonalHost
} from '../services/codebuddy/config.js';

const authStates = new Map();
const AUTH_STATE_TTL = 30 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [state, value] of authStates) {
        if (now - value.createdAt > AUTH_STATE_TTL) authStates.delete(state);
    }
}, 10 * 60 * 1000).unref();

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

function authHeaders(baseUrl, polling = false) {
    const requestId = randomUUID().replace(/-/g, '');
    const host = new URL(baseUrl).host;
    const headers = {
        Host: host,
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Request-ID': requestId,
        'X-Domain': host,
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
        'X-Product': 'SaaS'
    };
    if (!polling) headers['Content-Type'] = 'application/json';
    if (polling) {
        const spanId = randomBytes(8).toString('hex');
        headers.b3 = `${requestId}-${spanId}-1-`;
        headers['X-B3-TraceId'] = requestId;
        headers['X-B3-ParentSpanId'] = '';
        headers['X-B3-SpanId'] = spanId;
        headers['X-B3-Sampled'] = '1';
    }
    return headers;
}

function decodeJwtPayload(token) {
    try {
        const payload = token?.split('.')[1];
        if (!payload) return {};
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return {};
    }
}

async function startAuth(req, res, tenantId) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const baseUrl = getCodebuddyBaseUrl(url.searchParams.get('base_url'));
    const host = new URL(baseUrl).host;
    if (BLOCKED_DOMAINS.includes(host)) {
        return sendJson(res, 400, {error: `域名 ${host} 已废弃，不允许添加凭证`});
    }

    const nonce = randomBytes(8).toString('hex');
    const response = await fetch(`${baseUrl}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
        method: 'POST',
        headers: authHeaders(baseUrl),
        body: JSON.stringify({nonce})
    });
    if (!response.ok) throw new Error(`认证服务返回 HTTP ${response.status}`);

    const result = await response.json();
    const state = result.data?.state;
    const authUrl = result.data?.authUrl;
    if (result.code !== 0 || !state || !authUrl) {
        throw new Error(result.msg || '认证服务返回了无效响应');
    }

    authStates.set(state, {createdAt: Date.now(), tenantId, baseUrl});
    return sendJson(res, 200, {
        success: true,
        auth_state: state,
        verification_uri_complete: authUrl,
        verification_uri: baseUrl,
        ...(!isPersonalHost(host) && {logout_uri: new URL('/console/logout', baseUrl).toString()}),
        expires_in: 1800,
        interval: 5
    });
}

async function pollAuth(req, res, tenantId) {
    const {auth_state: authState} = await readRequestBody(req);
    const record = authStates.get(authState);
    if (!authState || !record || Number(record.tenantId) !== Number(tenantId)) {
        return sendJson(res, 400, {status: 'error', message: '认证状态不存在或已过期'});
    }

    const response = await fetch(`${record.baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(authState)}`, {
        headers: authHeaders(record.baseUrl, true)
    });
    if (!response.ok) throw new Error(`认证服务返回 HTTP ${response.status}`);

    const result = await response.json();
    if (result.code === 11217) {
        return sendJson(res, 200, {status: 'pending', message: result.msg || '等待用户登录'});
    }
    if (result.code !== 0 || !result.data?.accessToken) {
        return sendJson(res, 400, {status: 'error', message: result.msg || '认证失败'});
    }

    const tokenData = result.data;
    const payload = decodeJwtPayload(tokenData.accessToken);
    const userId = payload.email || payload.preferred_username || payload.sub || 'unknown';
    let accountInfo = {};

    if (!isPersonalHost(new URL(record.baseUrl).host)) {
        try {
            const accountResponse = await fetch(
                `${record.baseUrl}/v2/plugin/login/account?state=${encodeURIComponent(authState)}`,
                {
                    headers: {
                        ...authHeaders(record.baseUrl, true),
                        Authorization: `Bearer ${tokenData.accessToken}`
                    }
                }
            );
            if (accountResponse.ok) {
                const accountResult = await accountResponse.json();
                accountInfo = accountResult.data || {};
            }
        } catch (error) {
            logger.warn(`CodeBuddy account info request failed: ${error.message}`);
        }
    }

    const manager = await unifiedTenantManager.getCodebuddyCredentialManager(tenantId);
    if (!manager) return sendJson(res, 404, {status: 'error', message: '租户不存在'});

    const saved = await manager.addCredentialWithData({
        bearer_token: tokenData.accessToken,
        refresh_token: tokenData.refreshToken,
        token_type: tokenData.tokenType || 'Bearer',
        user_id: userId,
        user_info: {
            sub: payload.sub,
            email: payload.email,
            preferred_username: payload.preferred_username,
            name: payload.name
        },
        base_url: record.baseUrl,
        enterprise_id: accountInfo.enterpriseId || '',
        enterprise_name: accountInfo.enterpriseName || '',
        department_info: accountInfo.departmentFullName || '',
        domain: tokenData.domain,
        scope: tokenData.scope,
        expires_in: tokenData.expiresIn,
        created_at: Math.floor(Date.now() / 1000)
    });

    authStates.delete(authState);
    if (saved) {
        await unifiedTenantManager.refreshCodebuddyCredentials(tenantId);
        broadcast('codebuddy:credential:change', {tenantId});
    }
    return sendJson(res, saved ? 200 : 500, {
        status: saved ? 'success' : 'error',
        message: saved ? '认证成功，凭证已保存' : '凭证保存失败'
    });
}

export function getCodebuddyAdminOptions() {
    const defaults = [getCodebuddyBaseUrl()];
    return [...new Set([...defaults, ...getExtraBaseUrls()])].map(url => ({
        url,
        host: new URL(url).host,
        personal: isPersonalHost(new URL(url).host),
        label: isPersonalHost(new URL(url).host) ? '\u4e2a\u4eba\u7ad9' : getCodebuddyCustomSiteLabel(url),
        models: getModelsForHost(url)
    }));
}

export async function handleCodebuddyAdminRoute(req, res, tenantId, subPath) {
    if (!subPath.startsWith('/codebuddy/')) return false;

    const method = req.method;
    const manager = await unifiedTenantManager.getCodebuddyCredentialManager(tenantId);
    if (!manager) {
        sendJson(res, 404, {error: '租户不存在'});
        return true;
    }

    try {
        if (subPath === '/codebuddy/credentials' && method === 'GET') {
            sendJson(res, 200, {
                credentials: manager.getCredentialsInfo(),
                currentIndex: manager.currentIndex
            });
            return true;
        }
        if (subPath === '/codebuddy/credentials/delete' && method === 'POST') {
            const {index} = await readRequestBody(req);
            const ok = await manager.deleteCredential(Number(index));
            if (ok) broadcast('codebuddy:credential:change', {tenantId});
            sendJson(res, ok ? 200 : 400, ok ? {message: '凭证已删除'} : {error: '无效的凭证'});
            return true;
        }
        if (subPath === '/codebuddy/credentials/select' && method === 'POST') {
            const {index} = await readRequestBody(req);
            const ok = await manager.setActiveCredential(Number(index));
            if (ok) broadcast('codebuddy:credential:change', {tenantId});
            sendJson(res, ok ? 200 : 400, ok ? {message: '活跃凭证已切换'} : {error: '无效的凭证'});
            return true;
        }
        if (subPath === '/codebuddy/credentials/toggle' && method === 'POST') {
            const {index} = await readRequestBody(req);
            const result = await manager.toggleCredentialDisable(Number(index));
            broadcast('codebuddy:credential:change', {tenantId});
            sendJson(res, 200, {message: result.disabled ? '凭证已禁用' : '凭证已启用'});
            return true;
        }
        if (subPath === '/codebuddy/credentials/move-up' && method === 'POST') {
            const {index} = await readRequestBody(req);
            const ok = await manager.moveCredential(Number(index), 'up');
            if (ok) broadcast('codebuddy:credential:change', {tenantId});
            sendJson(res, ok ? 200 : 400, ok ? {message: '凭证已上移'} : {error: '无法上移该凭证'});
            return true;
        }
        if (subPath === '/codebuddy/credentials/move-down' && method === 'POST') {
            const {index} = await readRequestBody(req);
            const ok = await manager.moveCredential(Number(index), 'down');
            if (ok) broadcast('codebuddy:credential:change', {tenantId});
            sendJson(res, ok ? 200 : 400, ok ? {message: '凭证已下移'} : {error: '无法下移该凭证'});
            return true;
        }
        if (subPath === '/codebuddy/auth/start' && method === 'GET') {
            await startAuth(req, res, tenantId);
            return true;
        }
        if (subPath === '/codebuddy/auth/poll' && method === 'POST') {
            await pollAuth(req, res, tenantId);
            return true;
        }
        return false;
    } catch (error) {
        logger.error(`CodeBuddy admin route failed (${subPath}):`, error);
        sendJson(res, 500, {error: error.message});
        return true;
    }
}
