import test from 'node:test';
import assert from 'node:assert/strict';

import {TenantTokenManager} from '../src/services/codebuddy/tenant-token-manager.js';
import {models} from '../src/db/models/index.js';

test('CodeBuddy credential move keeps active and disabled state attached to moved credentials', async () => {
    const originalUpdate = models.TenantCredential.update;
    const updates = [];
    models.TenantCredential.update = async (values, options) => {
        updates.push({values, where: options.where});
        return [1];
    };

    const manager = new TenantTokenManager('', {tenantId: 7});
    manager.credentials = [
        {id: 11, data: {user_id: 'first'}},
        {id: 12, data: {user_id: 'second'}},
        {id: 13, data: {user_id: 'third'}}
    ];
    manager.currentIndex = 1;
    manager.disabledIndexes = [2];
    manager.saveState = async () => {};

    try {
        const ok = await manager.moveCredential(1, 'up');

        assert.equal(ok, true);
        assert.deepEqual(manager.credentials.map(c => c.id), [12, 11, 13]);
        assert.equal(manager.currentIndex, 0);
        assert.deepEqual(manager.disabledIndexes, [2]);
        assert.deepEqual(updates.map(u => [u.where.id, u.values.sort_order]), [[12, 0], [11, 1], [13, 2]]);
    } finally {
        models.TenantCredential.update = originalUpdate;
    }
});
