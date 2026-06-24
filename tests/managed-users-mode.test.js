import test from 'node:test';
import assert from 'node:assert/strict';
import {Op} from 'sequelize';

import {
    listManagedUsers,
    updateManagedUser,
    deleteManagedUser,
    changeOwnLocalUserPassword
} from '../src/services/gateway/index.js';
import {models} from '../src/db/models/index.js';
import {hashPassword, verifyPassword} from '../src/services/shared/local-auth.js';

function tenantRow(data) {
    return {
        created_at: data.created_at || new Date('2026-06-01T00:00:00Z'),
        ...data
    };
}

test('LDAP mode lists LDAP tenant users instead of local password users', async () => {
    const originalFindAll = models.Tenant.findAll;
    const whereClauses = [];

    models.Tenant.findAll = async (options = {}) => {
        whereClauses.push(options.where);
        return [
            tenantRow({username: 'ldap-admin', name: 'LDAP Admin', role: 'admin', password_hash: null}),
            tenantRow({username: 'ldap-user', name: 'LDAP User', role: 'user', password_hash: null})
        ];
    };

    try {
        const users = await listManagedUsers('admin', 'ldap');
        assert.deepEqual(whereClauses, [{password_hash: null}]);
        assert.deepEqual(users.map(u => ({
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            source: u.source
        })), [
            {
                username: 'ldap-admin',
                displayName: 'LDAP Admin',
                role: 'admin',
                source: 'ldap'
            },
            {
                username: 'ldap-user',
                displayName: 'LDAP User',
                role: 'user',
                source: 'ldap'
            }
        ]);
    } finally {
        models.Tenant.findAll = originalFindAll;
    }
});

test('LDAP mode updates display name and role without requiring a local password', async () => {
    const originalFindOne = models.Tenant.findOne;
    const originalUpdate = models.Tenant.update;
    const updates = [];

    models.Tenant.findOne = async () => tenantRow({
        username: 'ldap-user',
        name: 'Old Name',
        role: 'user',
        password_hash: null
    });
    models.Tenant.update = async (values, options) => {
        updates.push({values, where: options.where});
        return [1];
    };

    try {
        const result = await updateManagedUser('ldap-user', {displayName: 'New Name', role: 'admin'}, 'superadmin', 'ldap');
        assert.equal(result.ok, true);
        assert.deepEqual(updates, [{
            values: {name: 'New Name', role: 'admin'},
            where: {username: 'ldap-user', password_hash: null}
        }]);
    } finally {
        models.Tenant.findOne = originalFindOne;
        models.Tenant.update = originalUpdate;
    }
});

test('LDAP mode deletes LDAP users without matching local password rows', async () => {
    const originalFindOne = models.Tenant.findOne;
    const originalDestroy = models.Tenant.destroy;
    const destroys = [];

    models.Tenant.findOne = async () => tenantRow({
        username: 'ldap-user',
        name: 'LDAP User',
        role: 'user',
        password_hash: null
    });
    models.Tenant.destroy = async (options) => {
        destroys.push(options.where);
        return 1;
    };

    try {
        const result = await deleteManagedUser('ldap-user', 'admin-user', 'admin', 'ldap');
        assert.equal(result.ok, true);
        assert.deepEqual(destroys, [{username: 'ldap-user', password_hash: null}]);
    } finally {
        models.Tenant.findOne = originalFindOne;
        models.Tenant.destroy = originalDestroy;
    }
});

test('local users can change their own password only with the current password', async () => {
    const originalFindOne = models.Tenant.findOne;
    const originalUpdate = models.Tenant.update;
    const initial = hashPassword('old-password');
    const updates = [];

    models.Tenant.findOne = async () => tenantRow({
        username: 'alice',
        name: 'Alice',
        role: 'user',
        password_hash: initial.hash,
        password_salt: initial.salt
    });
    models.Tenant.update = async (values, options) => {
        updates.push({values, where: options.where});
        return [1];
    };

    try {
        const denied = await changeOwnLocalUserPassword('alice', 'wrong-password', 'new-password');
        assert.equal(denied.ok, false);
        assert.equal(denied.status, 403);
        assert.equal(updates.length, 0);

        const changed = await changeOwnLocalUserPassword('alice', 'old-password', 'new-password');
        assert.equal(changed.ok, true);
        assert.equal(updates.length, 1);
        assert.deepEqual(updates[0].where, {username: 'alice', password_hash: {[Op.ne]: null}});
        assert.equal(verifyPassword('new-password', updates[0].values.password_hash, updates[0].values.password_salt), true);
    } finally {
        models.Tenant.findOne = originalFindOne;
        models.Tenant.update = originalUpdate;
    }
});

test('env configured superadmin cannot change password from the dashboard', async () => {
    const originalAdminUser = process.env.LOCAL_ADMIN_USER;
    process.env.LOCAL_ADMIN_USER = 'root';

    try {
        const result = await changeOwnLocalUserPassword('root', 'old-password', 'new-password');
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    } finally {
        if (originalAdminUser === undefined) delete process.env.LOCAL_ADMIN_USER;
        else process.env.LOCAL_ADMIN_USER = originalAdminUser;
    }
});
