import {AsyncLocalStorage} from 'async_hooks';
import {copilotCredentialManager} from './credential-manager.js';
import {unifiedTenantManager} from '../gateway/tenant-manager.js';
import {DEFAULT_VSCODE_VERSION} from './config.js';

const storage = new AsyncLocalStorage();

export function currentCopilotContext() {
    const context = storage.getStore();
    if (!context) throw new Error('Copilot tenant context is unavailable');
    return context;
}

export function runWithCopilotContext(context, callback) {
    return storage.run(context, callback);
}

export async function runCopilotTenantContext(tenantId, callback) {
    const credential = await copilotCredentialManager.resolve(tenantId);
    return storage.run({tenantId: Number(tenantId), credential}, callback);
}

export const copilotState = new Proxy({}, {
    get(_target, property) {
        const {credential} = currentCopilotContext();
        if (property === 'githubToken') return credential.github_token;
        if (property === 'copilotToken') return credential.copilot_token;
        if (property === 'vsCodeVersion') return credential.vscode_version || DEFAULT_VSCODE_VERSION;
        if (property === 'accountType') return credential.account_type || 'individual';
        if (property === 'userInfo') {
            return credential.github_user
                ? {login: credential.github_user, avatar_url: credential.avatar_url || ''}
                : null;
        }
        return undefined;
    }
});

export const copilotStore = {
    getProxyUrl() {
        return currentCopilotContext().credential.proxy || undefined;
    },
    getRejectUnauthorized() {
        return currentCopilotContext().credential.skip_tls_verify !== true;
    },
    incrementApiCallCount() {
        const {tenantId} = currentCopilotContext();
        unifiedTenantManager.incrementApiCallCount(tenantId, 'copilot');
    },
    incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens = 0) {
        const {tenantId} = currentCopilotContext();
        unifiedTenantManager.incrementTokenUsage(
            tenantId,
            'copilot',
            inputTokens,
            outputTokens,
            cacheHitTokens
        );
    },
    recordDailyUsage(inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown') {
        const {tenantId} = currentCopilotContext();
        unifiedTenantManager.recordDailyUsage(
            tenantId,
            'copilot',
            inputTokens,
            outputTokens,
            cacheHitTokens,
            0,
            model
        );
    }
};
