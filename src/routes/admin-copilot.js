import {models} from '../db/models/index.js';
import {copilotCredentialManager} from '../services/copilot/credential-manager.js';
import {DEFAULT_VSCODE_VERSION} from '../services/copilot/config.js';
import logger from '../utils/logger.js';

const ACCOUNT_TYPES = new Set(['individual', 'business', 'enterprise']);

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

function view(credential) {
    const expiresAt = credential.copilot_token_expires_at
        ? new Date(credential.copilot_token_expires_at)
        : null;
    return {
        id: credential.id,
        name: credential.name || '',
        github_user: credential.github_user || '',
        avatar_url: credential.avatar_url || '',
        authenticated: !!credential.github_token,
        has_copilot_token: !!credential.copilot_token,
        token_expires_at: expiresAt?.toISOString() || null,
        token_expired: !!expiresAt && expiresAt.getTime() <= Date.now(),
        proxy: credential.proxy || '',
        skip_tls_verify: credential.skip_tls_verify === true,
        account_type: credential.account_type || 'individual',
        vscode_version: credential.vscode_version || DEFAULT_VSCODE_VERSION,
        enabled: credential.enabled === true,
        is_active: credential.is_active === true,
        sort_order: credential.sort_order || 0
    };
}

function editableValues(data) {
    const values = {};
    if ('name' in data) values.name = String(data.name || '').trim().slice(0, 100);
    if ('proxy' in data) values.proxy = String(data.proxy || '').trim() || null;
    if ('skip_tls_verify' in data) values.skip_tls_verify = data.skip_tls_verify === true;
    if ('enabled' in data) values.enabled = data.enabled === true;
    if ('vscode_version' in data) {
        values.vscode_version = String(data.vscode_version || '').trim() || DEFAULT_VSCODE_VERSION;
    }
    if ('account_type' in data) {
        if (!ACCOUNT_TYPES.has(data.account_type)) throw new Error('Invalid Copilot account type');
        values.account_type = data.account_type;
    }
    return values;
}

export async function handleCopilotAdminRoute(req, res, tenantId, subPath) {
    const base = '/copilot-credentials';
    if (!subPath.startsWith(base)) return false;

    try {
        if (subPath === base && req.method === 'GET') {
            const credentials = await models.TenantCopilotCredential.findAll({
                where: {tenant_id: tenantId},
                order: [['sort_order', 'ASC'], ['id', 'ASC']]
            });
            sendJson(res, 200, {credentials: credentials.map(view)});
            return true;
        }

        if (subPath === base && req.method === 'POST') {
            const data = await readBody(req);
            const count = await models.TenantCopilotCredential.count({where: {tenant_id: tenantId}});
            const credential = await models.TenantCopilotCredential.create({
                tenant_id: tenantId,
                name: String(data.name || 'GitHub Copilot').trim().slice(0, 100),
                proxy: String(data.proxy || '').trim() || null,
                skip_tls_verify: data.skip_tls_verify === true,
                account_type: ACCOUNT_TYPES.has(data.account_type) ? data.account_type : 'individual',
                vscode_version: String(data.vscode_version || '').trim() || DEFAULT_VSCODE_VERSION,
                enabled: data.enabled !== false,
                sort_order: count
            });
            const active = await models.TenantCopilotCredential.findOne({
                where: {tenant_id: tenantId, enabled: true, is_active: true}
            });
            if (!active && credential.enabled) {
                await credential.update({is_active: true});
            }
            sendJson(res, 201, {credential: view(credential)});
            return true;
        }

        const match = subPath.match(/^\/copilot-credentials\/(\d+)(\/auth\/(start|poll|clear)|\/refresh|\/active|\/toggle|\/move-(up|down))?$/);
        if (!match) return false;
        const credentialId = Number(match[1]);
        const action = match[3] || '';

        if (!action && req.method === 'PUT') {
            const credential = await copilotCredentialManager.get(tenantId, credentialId);
            const values = editableValues(await readBody(req));
            await credential.update(values);
            if ('enabled' in values) {
                await copilotCredentialManager.setEnabled(tenantId, credentialId, values.enabled);
            }
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (!action && req.method === 'DELETE') {
            const credential = await copilotCredentialManager.get(tenantId, credentialId);
            await credential.destroy();
            sendJson(res, 200, {message: 'Copilot credential deleted'});
            return true;
        }

        if (action === 'start' && req.method === 'POST') {
            const device = await copilotCredentialManager.startDeviceAuth(tenantId, credentialId);
            sendJson(res, 200, {
                device_code: device.device_code,
                user_code: device.user_code,
                verification_uri: device.verification_uri,
                expires_in: device.expires_in,
                interval: device.interval || 5
            });
            return true;
        }

        if (action === 'poll' && req.method === 'POST') {
            const {device_code: deviceCode} = await readBody(req);
            if (!deviceCode) {
                sendJson(res, 400, {error: 'device_code is required'});
                return true;
            }
            try {
                const credential = await copilotCredentialManager.pollDeviceAuth(
                    tenantId,
                    credentialId,
                    deviceCode
                );
                sendJson(res, 200, {status: 'success', credential: view(credential)});
            } catch (error) {
                if (['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(error.code)) {
                    sendJson(res, 200, {status: error.code, message: error.message});
                } else {
                    throw error;
                }
            }
            return true;
        }

        if (action === 'clear' && req.method === 'POST') {
            const credential = await copilotCredentialManager.clearAuthentication(tenantId, credentialId);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (match[2] === '/refresh' && req.method === 'POST') {
            await copilotCredentialManager.ensureToken(tenantId, credentialId);
            const credential = await copilotCredentialManager.get(tenantId, credentialId);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (match[2] === '/active' && req.method === 'POST') {
            const credential = await copilotCredentialManager.setActive(tenantId, credentialId);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (match[2] === '/toggle' && req.method === 'POST') {
            const credential = await copilotCredentialManager.get(tenantId, credentialId);
            const updated = await copilotCredentialManager.setEnabled(tenantId, credentialId, !credential.enabled);
            sendJson(res, 200, {credential: view(updated)});
            return true;
        }

        if (match[2]?.startsWith('/move-') && req.method === 'POST') {
            const direction = match[4];
            const credential = await copilotCredentialManager.moveCredential(tenantId, credentialId, direction);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }
    } catch (error) {
        logger.error(`Copilot admin operation failed for tenant ${tenantId}: ${error.message}`);
        const status = error.message === 'Copilot credential not found' ? 404 : 400;
        sendJson(res, status, {error: error.message});
        return true;
    }

    return false;
}
