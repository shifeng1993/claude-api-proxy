import test from 'node:test';
import assert from 'node:assert/strict';
import {models} from '../src/db/models/index.js';
import {unifiedTenantManager} from '../src/services/gateway/index.js';
import {
    listLocalUsers,
    createLocalUser,
    updateLocalUser,
    resetLocalUserPassword,
    deleteLocalUser
} from '../src/services/gateway/index.js';
import {ensureAdminFromEnv} from '../src/services/shared/local-auth.js';
import {canManageDashboardTenant} from '../src/routes/dashboard-frontend.js';

function patchTenant(t, overrides) {
    const original = {};
    for (const [key, value] of Object.entries(overrides)) {
        original[key] = models.Tenant[key];
        models.Tenant[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(original)) {
            models.Tenant[key] = value;
        }
    });
}

function tenant(row) {
    return {
        name: row.displayName || row.username,
        created_at: row.createdAt || new Date('2026-06-06T00:00:00Z'),
        ...row
    };
}

test('local user listing hides superadmin and lets admins view peer admins and users', async t => {
    patchTenant(t, {
        findAll: async () => [
            tenant({username: 'root', role: 'superadmin'}),
            tenant({username: 'admin-a', role: 'admin'}),
            tenant({username: 'alice', role: 'user'})
        ]
    });

    assert.deepEqual((await listLocalUsers('superadmin')).map(user => user.username), ['admin-a', 'alice']);
    assert.deepEqual((await listLocalUsers('admin')).map(user => user.username), ['admin-a', 'alice']);
});

test('only superadmin can create administrator accounts', async t => {
    const originalBulkCreate = models.TenantServiceProfile.bulkCreate;
    const created = [];
    patchTenant(t, {
        findOne: async () => null,
        create: async body => {
            created.push(body);
            return {id: created.length, ...body};
        }
    });
    models.TenantServiceProfile.bulkCreate = async () => {};
    t.after(() => {
        models.TenantServiceProfile.bulkCreate = originalBulkCreate;
    });

    const denied = await createLocalUser({
        username: 'admin-a',
        password: 'password123',
        displayName: 'Admin A',
        role: 'admin'
    }, 'admin');
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);

    const allowed = await createLocalUser({
        username: 'admin-a',
        password: 'password123',
        displayName: 'Admin A',
        role: 'admin'
    }, 'superadmin');
    assert.equal(allowed.ok, true);
    assert.equal(created[0].role, 'admin');
});

test('admins cannot reset or delete administrator accounts', async t => {
    patchTenant(t, {
        findOne: async ({where}) => tenant({username: where.username, role: where.username === 'admin-a' ? 'admin' : 'user'}),
        update: async () => [1],
        destroy: async () => 1
    });

    assert.equal((await resetLocalUserPassword('admin-a', 'password123', 'admin')).status, 403);
    assert.equal((await deleteLocalUser('admin-a', 'root', 'admin')).status, 403);
    assert.equal((await resetLocalUserPassword('alice', 'password123', 'admin')).ok, true);
    assert.equal((await deleteLocalUser('alice', 'root', 'admin')).ok, true);
});

test('superadmin can edit managed user display name and role', async t => {
    const updates = [];
    patchTenant(t, {
        findOne: async ({where}) => tenant({username: where.username, role: 'user'}),
        update: async (body) => {
            updates.push(body);
            return [1];
        }
    });

    const result = await updateLocalUser('alice', {displayName: 'Alice Ops', role: 'admin'}, 'superadmin');

    assert.equal(result.ok, true);
    assert.deepEqual(updates[0], {name: 'Alice Ops', role: 'admin'});
});

test('admins can edit ordinary user display names but cannot promote users', async t => {
    const updates = [];
    patchTenant(t, {
        findOne: async ({where}) => tenant({username: where.username, role: where.username === 'admin-a' ? 'admin' : 'user'}),
        update: async (body) => {
            updates.push(body);
            return [1];
        }
    });

    const renamed = await updateLocalUser('alice', {displayName: 'Alice Team'}, 'admin');
    assert.equal(renamed.ok, true);
    assert.deepEqual(updates[0], {name: 'Alice Team', role: 'user'});

    const promoted = await updateLocalUser('alice', {displayName: 'Alice Team', role: 'admin'}, 'admin');
    assert.equal(promoted.ok, false);
    assert.equal(promoted.status, 403);

    const adminTarget = await updateLocalUser('admin-a', {displayName: 'Admin A'}, 'admin');
    assert.equal(adminTarget.ok, false);
    assert.equal(adminTarget.status, 403);
});

test('environment bootstrap synchronizes the initial account as superadmin', async t => {
    const originalEnv = {
        LOCAL_ADMIN_USER: process.env.LOCAL_ADMIN_USER,
        LOCAL_ADMIN_PASSWORD: process.env.LOCAL_ADMIN_PASSWORD
    };
    process.env.LOCAL_ADMIN_USER = 'root';
    process.env.LOCAL_ADMIN_PASSWORD = 'password123';
    t.after(() => {
        if (originalEnv.LOCAL_ADMIN_USER === undefined) delete process.env.LOCAL_ADMIN_USER;
        else process.env.LOCAL_ADMIN_USER = originalEnv.LOCAL_ADMIN_USER;
        if (originalEnv.LOCAL_ADMIN_PASSWORD === undefined) delete process.env.LOCAL_ADMIN_PASSWORD;
        else process.env.LOCAL_ADMIN_PASSWORD = originalEnv.LOCAL_ADMIN_PASSWORD;
    });

    let updateBody;
    const originalFindOrCreate = models.TenantServiceProfile.findOrCreate;
    patchTenant(t, {
        findOne: async () => ({id: 9}),
        update: async body => {
            updateBody = body;
            return [1];
        }
    });
    models.TenantServiceProfile.findOrCreate = async () => [];
    t.after(() => {
        models.TenantServiceProfile.findOrCreate = originalFindOrCreate;
    });

    await ensureAdminFromEnv();
    assert.equal(updateBody.role, 'superadmin');
});

test('LDAP auto-created initial account is a superadmin', async t => {
    const originalAdminUser = process.env.LOCAL_ADMIN_USER;
    process.env.LOCAL_ADMIN_USER = 'root';
    t.after(() => {
        if (originalAdminUser === undefined) delete process.env.LOCAL_ADMIN_USER;
        else process.env.LOCAL_ADMIN_USER = originalAdminUser;
    });

    const originalBulkCreate = models.TenantServiceProfile.bulkCreate;
    const originalCache = unifiedTenantManager.tenantsCache;
    const originalUsernameMap = unifiedTenantManager.usernameMap;
    const created = [];
    patchTenant(t, {
        create: async body => {
            created.push({id: 12, ...body});
            return {id: 12, ...body};
        },
        findAll: async () => created.map(row => ({toJSON: () => row}))
    });
    models.TenantServiceProfile.bulkCreate = async () => {};
    unifiedTenantManager.tenantsCache = new Map();
    unifiedTenantManager.usernameMap = new Map();
    t.after(() => {
        models.TenantServiceProfile.bulkCreate = originalBulkCreate;
        unifiedTenantManager.tenantsCache = originalCache;
        unifiedTenantManager.usernameMap = originalUsernameMap;
    });

    const tenantId = await unifiedTenantManager.createTenantForUser('root', 'Root User');

    assert.equal(tenantId, 12);
    assert.equal(created[0].role, 'superadmin');
    assert.equal(unifiedTenantManager.getTenant(tenantId).role, 'superadmin');
});

test('unified tenant manager treats superadmin as administrator', () => {
    const original = unifiedTenantManager.tenantsCache;
    unifiedTenantManager.tenantsCache = new Map([
        [1, {id: 1, username: 'root', role: 'superadmin'}],
        [2, {id: 2, username: 'admin-a', role: 'admin'}],
        [3, {id: 3, username: 'alice', role: 'user'}]
    ]);
    try {
        assert.equal(unifiedTenantManager.isAdmin('root'), true);
        assert.equal(unifiedTenantManager.isAdmin('admin-a'), true);
        assert.equal(unifiedTenantManager.isAdmin('alice'), false);
    } finally {
        unifiedTenantManager.tenantsCache = original;
    }
});

test('dashboard tenant operations let admins manage only ordinary users', () => {
    assert.equal(canManageDashboardTenant('superadmin', {role: 'admin'}), true);
    assert.equal(canManageDashboardTenant('superadmin', {role: 'user'}), true);
    assert.equal(canManageDashboardTenant('superadmin', {role: 'superadmin'}), false);
    assert.equal(canManageDashboardTenant('admin', {role: 'user'}), true);
    assert.equal(canManageDashboardTenant('admin', {role: 'admin'}), false);
    assert.equal(canManageDashboardTenant('admin', {role: 'superadmin'}), false);
});
