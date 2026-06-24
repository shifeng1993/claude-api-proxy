import {
    copilotCredentialManager,
    toCopilotCredentialView as view
} from '../services/copilot/index.js';
import logger from '../utils/logger.js';

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

export async function handleCopilotAdminRoute(req, res, tenantId, subPath) {
    const base = '/copilot-credentials';
    if (!subPath.startsWith(base)) return false;

    try {
        if (subPath === base && req.method === 'GET') {
            const credentials = await copilotCredentialManager.listCredentials(tenantId);
            sendJson(res, 200, {credentials: credentials.map(view)});
            return true;
        }

        if (subPath === base && req.method === 'POST') {
            const data = await readBody(req);
            const credential = await copilotCredentialManager.createCredential(tenantId, data);
            sendJson(res, 201, {credential: view(credential)});
            return true;
        }

        const match = subPath.match(/^\/copilot-credentials\/(\d+)(\/auth\/(start|poll|clear)|\/refresh|\/active|\/toggle|\/move-(up|down))?$/);
        if (!match) return false;
        const credentialId = Number(match[1]);
        const action = match[3] || '';

        if (!action && req.method === 'PUT') {
            const credential = await copilotCredentialManager.updateCredential(
                tenantId,
                credentialId,
                await readBody(req)
            );
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (!action && req.method === 'DELETE') {
            await copilotCredentialManager.deleteCredential(tenantId, credentialId);
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
            const credential = await copilotCredentialManager.refreshCredential(tenantId, credentialId);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (match[2] === '/active' && req.method === 'POST') {
            const credential = await copilotCredentialManager.setActive(tenantId, credentialId);
            sendJson(res, 200, {credential: view(credential)});
            return true;
        }

        if (match[2] === '/toggle' && req.method === 'POST') {
            const updated = await copilotCredentialManager.toggleCredentialEnabled(tenantId, credentialId);
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
