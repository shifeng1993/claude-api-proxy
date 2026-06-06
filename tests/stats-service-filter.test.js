import test from 'node:test';
import assert from 'node:assert/strict';

import {routeStatsRequest} from '../src/routes/stats.js';
import {TenantDailyUsage} from '../src/db/models/tenant-daily-usage.js';
import {unifiedTenantManager} from '../src/services/gateway/tenant-manager.js';

function mockJsonResponse() {
    return {
        status: 0,
        body: '',
        writeHead(status) {
            this.status = status;
        },
        end(chunk = '') {
            this.body += chunk;
        }
    };
}

test('stats overview filters daily usage by requested service endpoint', async () => {
    const originalFindAll = TenantDailyUsage.findAll;
    const originalIsEnabled = unifiedTenantManager.isEnabled;
    const originalRegistry = unifiedTenantManager.registry;
    const serviceFilters = [];

    TenantDailyUsage.findAll = async (options = {}) => {
        if (options.where?.service_type) serviceFilters.push(options.where.service_type);
        return [];
    };
    unifiedTenantManager.isEnabled = () => true;
    unifiedTenantManager.registry = {
        tenants: {
            tenant_1: {
                id: 1,
                name: 'Alice',
                username: 'alice',
                created_at: Date.now(),
                serviceProfiles: []
            }
        }
    };

    try {
        const req = {
            method: 'GET',
            url: '/stats/api/overview?service=copilot&startDate=2026-06-07&endDate=2026-06-07',
            headers: {host: 'localhost'},
            socket: {remoteAddress: '127.0.0.1'}
        };
        const res = mockJsonResponse();

        assert.equal(await routeStatsRequest(req, res), true);
        assert.equal(res.status, 200);
        assert.ok(serviceFilters.length >= 3);
        assert.deepEqual([...new Set(serviceFilters)], ['copilot']);
    } finally {
        TenantDailyUsage.findAll = originalFindAll;
        unifiedTenantManager.isEnabled = originalIsEnabled;
        unifiedTenantManager.registry = originalRegistry;
    }
});
