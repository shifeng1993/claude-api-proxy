import test from 'node:test';
import assert from 'node:assert/strict';

import {models} from '../src/db/models/index.js';
import {TenantServiceProfile} from '../src/db/models/tenant-service-profile.js';
import {unifiedTenantManager} from '../src/services/gateway/index.js';

test('flushes usage deltas to the matching tenant service profile', async () => {
    const originalIncrement = TenantServiceProfile.increment;
    const writes = [];

    TenantServiceProfile.increment = async (values, options) => {
        writes.push({values, where: options.where});
    };

    unifiedTenantManager._dirtyTenants.clear();
    unifiedTenantManager._deltaTenants.clear();

    try {
        unifiedTenantManager.incrementApiCallCount(42, 'relay');
        unifiedTenantManager.incrementTokenUsage(42, 'relay', 10, 20, 3);
        unifiedTenantManager.incrementApiCallCount(42, 'codebuddy');
        unifiedTenantManager.incrementTokenUsage(42, 'codebuddy', 7, 8, 1);
        await unifiedTenantManager._flushDirtyTenants();

        assert.deepEqual(writes, [
            {
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 10,
                    total_output_tokens: 20,
                    total_cache_hit_tokens: 3,
                    total_credit: 0
                },
                where: {tenant_id: 42, service_type: 'relay'}
            },
            {
                values: {
                    total_api_calls: 1,
                    total_input_tokens: 7,
                    total_output_tokens: 8,
                    total_cache_hit_tokens: 1,
                    total_credit: 0
                },
                where: {tenant_id: 42, service_type: 'codebuddy'}
            }
        ]);
    } finally {
        TenantServiceProfile.increment = originalIncrement;
        unifiedTenantManager._dirtyTenants.clear();
        unifiedTenantManager._deltaTenants.clear();
    }
});

test('records daily usage with service and schema field names', async () => {
    const originalFindOrCreate = models.TenantDailyUsage.findOrCreate;
    let findOptions;
    let incrementValues;

    models.TenantDailyUsage.findOrCreate = async options => {
        findOptions = options;
        return [{
            increment: async values => {
                incrementValues = values;
            }
        }];
    };

    try {
        await unifiedTenantManager.recordDailyUsage(42, 'codebuddy', 11, 12, 4, 1.5, 'claude-sonnet-4');

        assert.deepEqual(findOptions.where, {
            tenant_id: 42,
            service_type: 'codebuddy',
            date: findOptions.where.date,
            model: 'claude-sonnet-4'
        });
        assert.deepEqual(incrementValues, {
            api_calls: 1,
            input_tokens: 11,
            output_tokens: 12,
            input_cache_hit: 4,
            input_cache_miss: 7,
            credit: 1.5
        });
    } finally {
        models.TenantDailyUsage.findOrCreate = originalFindOrCreate;
    }
});
