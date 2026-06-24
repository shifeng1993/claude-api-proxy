import test from 'node:test';
import assert from 'node:assert/strict';

import {CopilotCredentialManager} from '../src/services/copilot/credential-manager.js';

function credential(overrides = {}) {
    return {
        id: 8,
        tenant_id: 42,
        enabled: true,
        github_token: 'gh-token',
        copilot_token: 'old-copilot-token',
        copilot_token_expires_at: new Date(Date.now() + 60_000),
        vscode_version: '1.109.2',
        account_type: 'individual',
        proxy: '',
        skip_tls_verify: false,
        async update(values) {
            Object.assign(this, values);
        },
        ...overrides
    };
}

test('refreshes an expiring Copilot token on the selected tenant credential', async () => {
    const row = credential();
    const queries = [];
    const model = {
        async findOne(options) {
            queries.push(options.where);
            return row;
        }
    };
    const githubApi = {
        async getCopilotToken(token, version) {
            assert.equal(token, 'gh-token');
            assert.equal(version, '1.109.2');
            return {token: 'fresh-token', expires_at: Math.floor(Date.now() / 1000) + 1800};
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi});

    const result = await manager.ensureToken(42, 8);

    assert.deepEqual(queries, [{id: 8, tenant_id: 42, enabled: true}]);
    assert.equal(result.token, 'fresh-token');
    assert.equal(row.copilot_token, 'fresh-token');
    assert.ok(row.copilot_token_expires_at instanceof Date);
});

test('stores device authorization only on the requested tenant credential', async () => {
    const row = credential({github_token: null, copilot_token: null});
    const model = {
        async findOne({where}) {
            assert.deepEqual(where, {id: 8, tenant_id: 42});
            return row;
        }
    };
    const githubApi = {
        async pollDeviceAuth(deviceCode) {
            assert.equal(deviceCode, 'device-code');
            return {
                githubToken: 'new-gh-token',
                userInfo: {login: 'octocat', avatar_url: 'https://example.test/avatar.png'},
                copilotToken: {token: 'new-copilot-token', expires_at: Math.floor(Date.now() / 1000) + 1800}
            };
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi});

    const result = await manager.pollDeviceAuth(42, 8, 'device-code');

    assert.equal(result.github_user, 'octocat');
    assert.equal(row.github_token, 'new-gh-token');
    assert.equal(row.copilot_token, 'new-copilot-token');
    assert.equal(row.avatar_url, 'https://example.test/avatar.png');
});

test('resolves the active enabled Copilot credential before other enabled credentials', async () => {
    const queries = [];
    const rows = [
        credential({id: 1, tenant_id: 42, enabled: true, is_active: false}),
        credential({id: 2, tenant_id: 42, enabled: true, is_active: true})
    ];
    const model = {
        async findOne(options) {
            queries.push(options);
            if (options.where.is_active === true) return rows.find(row => row.is_active);
            return rows.find(row => row.enabled);
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi: {}});

    const resolved = await manager.resolve(42);

    assert.equal(resolved.id, 2);
    assert.deepEqual(queries[0].where, {tenant_id: 42, enabled: true, is_active: true});
});

test('lists tenant Copilot credentials in admin order', async () => {
    const rows = [
        credential({id: 1, sort_order: 0}),
        credential({id: 2, sort_order: 1})
    ];
    const model = {
        async findAll(options) {
            assert.deepEqual(options, {
                where: {tenant_id: 42},
                order: [['sort_order', 'ASC'], ['id', 'ASC']]
            });
            return rows;
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi: {}});

    assert.equal(typeof manager.listCredentials, 'function');
    assert.deepEqual(await manager.listCredentials(42), rows);
});

test('creates the first enabled tenant Copilot credential as active', async () => {
    const created = credential({
        id: 9,
        tenant_id: 42,
        enabled: true,
        is_active: false,
        name: '',
        proxy: null,
        sort_order: 0
    });
    const calls = [];
    const model = {
        async count(options) {
            assert.deepEqual(options, {where: {tenant_id: 42}});
            return 0;
        },
        async create(values) {
            calls.push(['create', values]);
            Object.assign(created, values);
            return created;
        },
        async findOne(options) {
            calls.push(['findOne', options]);
            return null;
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi: {}});

    assert.equal(typeof manager.createCredential, 'function');
    const result = await manager.createCredential(42, {
        name: ' Team Copilot ',
        proxy: ' http://127.0.0.1:8080 ',
        skip_tls_verify: true,
        account_type: 'business',
        vscode_version: ' 1.2.3 ',
        enabled: true
    });

    assert.equal(result, created);
    assert.equal(created.is_active, true);
    assert.deepEqual(calls[0], ['create', {
        tenant_id: 42,
        name: 'Team Copilot',
        proxy: 'http://127.0.0.1:8080',
        skip_tls_verify: true,
        account_type: 'business',
        vscode_version: '1.2.3',
        enabled: true,
        sort_order: 0
    }]);
    assert.deepEqual(calls[1], ['findOne', {
        where: {tenant_id: 42, enabled: true, is_active: true}
    }]);
});

test('updates Copilot credential admin fields through manager normalization', async () => {
    const updates = [];
    const row = credential({
        id: 8,
        tenant_id: 42,
        enabled: true,
        is_active: true,
        async update(values) {
            updates.push(values);
            Object.assign(this, values);
        }
    });
    const model = {
        async findOne({where}) {
            if (where.tenant_id === 42 && where.enabled === true && !('id' in where)) return null;
            return row;
        }
    };
    const manager = new CopilotCredentialManager({credentialModel: model, githubApi: {}});

    assert.equal(typeof manager.updateCredential, 'function');
    const result = await manager.updateCredential(42, 8, {
        name: ' Enterprise Seat ',
        proxy: '   ',
        skip_tls_verify: true,
        account_type: 'enterprise',
        vscode_version: '   ',
        enabled: false
    });

    assert.equal(result, row);
    assert.equal(row.enabled, false);
    assert.equal(row.is_active, false);
    assert.deepEqual(updates[0], {
        name: 'Enterprise Seat',
        proxy: null,
        skip_tls_verify: true,
        account_type: 'enterprise',
        vscode_version: '1.109.2',
        enabled: false
    });
});
