import test from 'node:test';
import assert from 'node:assert/strict';

import {copilotCredentialManager} from '../src/services/copilot/credential-manager.js';
import {
    copilotState,
    copilotStore,
    runCopilotTenantContext
} from '../src/services/copilot/runtime.js';
import {unifiedTenantManager} from '../src/services/gateway/tenant-manager.js';
import {buildCopilotNetworkKey} from '../src/services/copilot/copilot-api.js';

test('keeps Copilot credential and usage context isolated across tenants', async () => {
    const originalModel = copilotCredentialManager.credentialModel;
    const originalIncrement = unifiedTenantManager.incrementApiCallCount;
    const usage = [];

    copilotCredentialManager.credentialModel = {
        async findOne({where}) {
            await new Promise(resolve => setTimeout(resolve, where.tenant_id === 1 ? 5 : 0));
            return {
                id: where.tenant_id * 10,
                tenant_id: where.tenant_id,
                enabled: true,
                github_token: `github-${where.tenant_id}`,
                copilot_token: `copilot-${where.tenant_id}`,
                github_user: `user-${where.tenant_id}`,
                proxy: `http://proxy-${where.tenant_id}.test`,
                skip_tls_verify: where.tenant_id === 2,
                vscode_version: '1.109.2',
                account_type: 'individual'
            };
        }
    };
    unifiedTenantManager.incrementApiCallCount = (tenantId, serviceType) => {
        usage.push({tenantId, serviceType});
    };

    try {
        const results = await Promise.all([1, 2].map(tenantId => (
            runCopilotTenantContext(tenantId, async () => {
                await new Promise(resolve => setTimeout(resolve, tenantId === 1 ? 0 : 5));
                copilotStore.incrementApiCallCount();
                return {
                    user: copilotState.userInfo.login,
                    proxy: copilotStore.getProxyUrl(),
                    rejectUnauthorized: copilotStore.getRejectUnauthorized()
                };
            })
        )));

        assert.deepEqual(results, [
            {user: 'user-1', proxy: 'http://proxy-1.test', rejectUnauthorized: true},
            {user: 'user-2', proxy: 'http://proxy-2.test', rejectUnauthorized: false}
        ]);
        assert.deepEqual(usage.sort((a, b) => a.tenantId - b.tenantId), [
            {tenantId: 1, serviceType: 'copilot'},
            {tenantId: 2, serviceType: 'copilot'}
        ]);
    } finally {
        copilotCredentialManager.credentialModel = originalModel;
        unifiedTenantManager.incrementApiCallCount = originalIncrement;
    }
});

test('Copilot WebSocket pool keys include tenant and credential identity', () => {
    assert.notEqual(
        buildCopilotNetworkKey('', true, {tenantId: 1, credentialId: 10}),
        buildCopilotNetworkKey('', true, {tenantId: 2, credentialId: 10})
    );
    assert.notEqual(
        buildCopilotNetworkKey('http://proxy.test', false, {tenantId: 1, credentialId: 10}),
        buildCopilotNetworkKey('http://proxy.test', false, {tenantId: 1, credentialId: 11})
    );
});
