import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyCredentialsHandler} from '../src/services/codebuddy/credentials-handler.js';

function createResponse() {
    return {calls: []};
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const manager = {
        getCredentialsInfo: () => [{id: 'cred-1'}],
        getCurrentCredentialInfo: () => ({id: 'cred-1'}),
        addCredentialWithData: async () => true,
        setActiveCredential: async () => true,
        deleteCredential: async () => true
    };
    return {
        calls,
        manager,
        resolveTenantManager: async () => ({manager, tenantId: 'tenant-1'}),
        credentialService: {
            syncCredentialCount: (tenantId) => calls.push(['syncCredentialCount', tenantId])
        },
        sendOpenAIError: (res, status, message) => res.calls.push(['openai-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({bearer_token: 'token', base_url: 'https://ok.example.com'}),
        getCodebuddyBaseUrl: (baseUrl) => baseUrl || 'https://ok.example.com',
        blockedDomains: ['blocked.example.com'],
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
}

test('handleCredentials lists tenant credentials', async () => {
    const res = createResponse();
    const handler = createCodebuddyCredentialsHandler(createBaseDeps());

    await handler({headers: {}}, res, 'GET', '/v1/credentials');

    assert.deepEqual(res.calls, [['json', 200, {credentials: [{id: 'cred-1'}]}]]);
});

test('handleCredentials rejects blocked credential domains before saving', async () => {
    const res = createResponse();
    let saved = false;
    const deps = createBaseDeps({
        manager: {
            addCredentialWithData: async () => {
                saved = true;
                return true;
            }
        },
        parseBody: async () => JSON.stringify({bearer_token: 'token', base_url: 'https://blocked.example.com'})
    });
    const handler = createCodebuddyCredentialsHandler(deps);

    await handler({headers: {}}, res, 'POST', '/v1/credentials');

    assert.equal(saved, false);
    assert.deepEqual(res.calls, [[
        'openai-error',
        400,
        'Domain blocked.example.com is deprecated and cannot be added'
    ]]);
});

test('handleCredentials syncs credential count after add and delete', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({bearer_token: 'token', base_url: 'https://ok.example.com', index: 0})
    });
    const handler = createCodebuddyCredentialsHandler(deps);

    await handler({headers: {}}, res, 'POST', '/v1/credentials');
    await handler({headers: {}}, res, 'POST', '/v1/credentials/delete');

    assert.deepEqual(deps.calls, [
        ['syncCredentialCount', 'tenant-1'],
        ['syncCredentialCount', 'tenant-1']
    ]);
    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[1][0], 'json');
});

test('handleCredentials maps tenant resolution errors', async () => {
    const res = createResponse();
    const handler = createCodebuddyCredentialsHandler(createBaseDeps({
        resolveTenantManager: async () => ({
            error: {status: 401, message: 'Unauthorized'}
        })
    }));

    await handler({headers: {}}, res, 'GET', '/v1/credentials');

    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized']]);
});
