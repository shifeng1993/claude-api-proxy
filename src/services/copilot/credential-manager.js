import {models} from '../../db/models/index.js';
import * as githubApi from './github-api.js';
import {DEFAULT_VSCODE_VERSION} from './config.js';

const ACCOUNT_TYPES = new Set(['individual', 'business', 'enterprise']);

function expiryDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
        return new Date(value < 10_000_000_000 ? value * 1000 : value);
    }
    return new Date(value);
}

function networkOptions(credential) {
    return {
        proxyUrl: credential.proxy || undefined,
        rejectUnauthorized: credential.skip_tls_verify !== true,
        timeout: 20_000
    };
}

function editableCredentialValues(data) {
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

export function toCopilotCredentialView(credential) {
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

export class CopilotCredentialManager {
    constructor({credentialModel = models.TenantCopilotCredential, githubApi: api = githubApi} = {}) {
        this.credentialModel = credentialModel;
        this.githubApi = api;
    }

    listCredentials(tenantId) {
        return this.credentialModel.findAll({
            where: {tenant_id: Number(tenantId)},
            order: [['sort_order', 'ASC'], ['id', 'ASC']]
        });
    }

    async createCredential(tenantId, data = {}) {
        const numericTenantId = Number(tenantId);
        const count = await this.credentialModel.count({where: {tenant_id: numericTenantId}});
        const credential = await this.credentialModel.create({
            tenant_id: numericTenantId,
            name: String(data.name || 'GitHub Copilot').trim().slice(0, 100),
            proxy: String(data.proxy || '').trim() || null,
            skip_tls_verify: data.skip_tls_verify === true,
            account_type: ACCOUNT_TYPES.has(data.account_type) ? data.account_type : 'individual',
            vscode_version: String(data.vscode_version || '').trim() || DEFAULT_VSCODE_VERSION,
            enabled: data.enabled !== false,
            sort_order: count
        });
        const active = await this.credentialModel.findOne({
            where: {tenant_id: numericTenantId, enabled: true, is_active: true}
        });
        if (!active && credential.enabled) {
            await credential.update({is_active: true});
        }
        return credential;
    }

    async updateCredential(tenantId, credentialId, data = {}) {
        const credential = await this.get(tenantId, credentialId);
        const values = editableCredentialValues(data);
        await credential.update(values);
        if ('enabled' in values) {
            return this.setEnabled(tenantId, credentialId, values.enabled);
        }
        return credential;
    }

    async deleteCredential(tenantId, credentialId) {
        const credential = await this.get(tenantId, credentialId);
        await credential.destroy();
        return credential;
    }

    async refreshCredential(tenantId, credentialId) {
        await this.ensureToken(tenantId, credentialId);
        return this.get(tenantId, credentialId);
    }

    async toggleCredentialEnabled(tenantId, credentialId) {
        const credential = await this.get(tenantId, credentialId);
        return this.setEnabled(tenantId, credentialId, !credential.enabled);
    }

    async get(tenantId, credentialId, requireEnabled = false) {
        const where = {id: Number(credentialId), tenant_id: Number(tenantId)};
        if (requireEnabled) where.enabled = true;
        const credential = await this.credentialModel.findOne({where});
        if (!credential) throw new Error('Copilot credential not found');
        return credential;
    }

    async resolve(tenantId, credentialId) {
        if (credentialId) return this.get(tenantId, credentialId, true);
        const active = await this.credentialModel.findOne({
            where: {tenant_id: Number(tenantId), enabled: true, is_active: true},
            order: [['id', 'ASC']]
        });
        if (active) return active;

        const credential = await this.credentialModel.findOne({
            where: {tenant_id: Number(tenantId), enabled: true},
            order: [['id', 'ASC']]
        });
        if (!credential) throw new Error('No enabled Copilot credential for this tenant');
        return credential;
    }

    async setActive(tenantId, credentialId) {
        const credential = await this.get(tenantId, credentialId, true);
        await this.credentialModel.update(
            {is_active: false},
            {where: {tenant_id: Number(tenantId)}}
        );
        await credential.update({is_active: true, enabled: true});
        return credential;
    }

    async setEnabled(tenantId, credentialId, enabled) {
        const credential = await this.get(tenantId, credentialId);
        await credential.update({enabled: enabled === true});
        if (enabled === true) {
            const active = await this.credentialModel.findOne({
                where: {tenant_id: Number(tenantId), enabled: true, is_active: true}
            });
            if (!active) await this.setActive(tenantId, credentialId);
        } else if (credential.is_active) {
            await credential.update({is_active: false});
            const fallback = await this.credentialModel.findOne({
                where: {tenant_id: Number(tenantId), enabled: true},
                order: [['id', 'ASC']]
            });
            if (fallback) await fallback.update({is_active: true});
        }
        return this.get(tenantId, credentialId);
    }

    async moveCredential(tenantId, credentialId, direction) {
        const credentials = await this.credentialModel.findAll({
            where: {tenant_id: Number(tenantId)},
            order: [['sort_order', 'ASC'], ['id', 'ASC']]
        });
        const index = credentials.findIndex(credential => Number(credential.id) === Number(credentialId));
        if (index < 0) throw new Error('Copilot credential not found');
        const targetIndex = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
        if (targetIndex < 0 || targetIndex >= credentials.length) {
            throw new Error(`Cannot move Copilot credential ${direction}`);
        }
        [credentials[index], credentials[targetIndex]] = [credentials[targetIndex], credentials[index]];
        await Promise.all(credentials.map((credential, sortOrder) => credential.update({sort_order: sortOrder})));
        return credentials[targetIndex];
    }

    startDeviceAuth(tenantId, credentialId) {
        return this.get(tenantId, credentialId).then(credential => (
            this.githubApi.startDeviceAuth(networkOptions(credential))
        ));
    }

    async pollDeviceAuth(tenantId, credentialId, deviceCode) {
        const credential = await this.get(tenantId, credentialId);
        const result = await this.githubApi.pollDeviceAuth(
            deviceCode,
            credential.vscode_version || DEFAULT_VSCODE_VERSION,
            networkOptions(credential)
        );
        await credential.update({
            github_token: result.githubToken,
            copilot_token: result.copilotToken?.token || null,
            copilot_token_expires_at: expiryDate(result.copilotToken?.expires_at),
            github_user: result.userInfo?.login || null,
            avatar_url: result.userInfo?.avatar_url || null
        });
        return credential;
    }

    async ensureToken(tenantId, credentialId) {
        const credential = await this.resolve(tenantId, credentialId);
        if (!credential.github_token) throw new Error('Copilot credential is not authenticated');

        const expiresAt = expiryDate(credential.copilot_token_expires_at)?.getTime() || 0;
        if (!credential.copilot_token || expiresAt <= Date.now() + 5 * 60_000) {
            const tokenData = await this.githubApi.getCopilotToken(
                credential.github_token,
                credential.vscode_version || DEFAULT_VSCODE_VERSION,
                networkOptions(credential)
            );
            await credential.update({
                copilot_token: tokenData.token,
                copilot_token_expires_at: expiryDate(tokenData.expires_at)
            });
        }
        return {credential, token: credential.copilot_token};
    }

    async clearAuthentication(tenantId, credentialId) {
        const credential = await this.get(tenantId, credentialId);
        await credential.update({
            github_token: null,
            copilot_token: null,
            copilot_token_expires_at: null,
            github_user: null,
            avatar_url: null
        });
        return credential;
    }
}

export const copilotCredentialManager = new CopilotCredentialManager();
