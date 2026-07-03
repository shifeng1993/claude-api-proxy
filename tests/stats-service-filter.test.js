import test from 'node:test';
import assert from 'node:assert/strict';
import {Op} from 'sequelize';

import {routeStatsRequest} from '../src/routes/stats.js';
import {TenantDailyUsage} from '../src/db/models/tenant-daily-usage.js';
import {createSessionToken, unifiedTenantManager} from '../src/services/gateway/index.js';

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

function sessionHeaders(username = 'alice', role = 'admin') {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'stats-service-filter-secret';
    return {
        host: 'localhost',
        cookie: `cap_session=${createSessionToken(username, role)}`
    };
}

function adminHeaders(username = 'alice') {
    return sessionHeaders(username, 'admin');
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
            url: '/stats/api/overview?service=codebuddy&startDate=2026-06-07&endDate=2026-06-07',
            headers: {host: 'localhost'},
            socket: {remoteAddress: '127.0.0.1'}
        };
        const res = mockJsonResponse();

        assert.equal(await routeStatsRequest(req, res), true);
        assert.equal(res.status, 200);
        assert.ok(serviceFilters.length >= 3);
        assert.deepEqual([...new Set(serviceFilters)], ['codebuddy']);
    } finally {
        TenantDailyUsage.findAll = originalFindAll;
        unifiedTenantManager.isEnabled = originalIsEnabled;
        unifiedTenantManager.registry = originalRegistry;
    }
});

test('stats overview excludes local superadmin and averages only cache-hit users', async () => {
    const originalFindAll = TenantDailyUsage.findAll;
    const originalIsEnabled = unifiedTenantManager.isEnabled;
    const originalRegistry = unifiedTenantManager.registry;

    let call = 0;
    TenantDailyUsage.findAll = async (options = {}) => {
        call++;
        if (call === 1) {
            return [
                {tenant_id: 1, apiCalls: 10, inputTokens: 1000, outputTokens: 100, cacheHitTokens: 900, credit: 1},
                {tenant_id: 2, apiCalls: 5, inputTokens: 500, outputTokens: 50, cacheHitTokens: 0, credit: 0.5},
                {tenant_id: 3, apiCalls: 100, inputTokens: 10000, outputTokens: 1000, cacheHitTokens: 5000, credit: 10}
            ];
        }
        return [];
    };
    unifiedTenantManager.isEnabled = () => true;
    unifiedTenantManager.registry = {
        tenants: {
            tenant_1: {id: 1, name: 'Alice', username: 'alice', role: 'user', created_at: Date.now(), serviceProfiles: []},
            tenant_2: {id: 2, name: 'Bob', username: 'bob', role: 'user', created_at: Date.now(), serviceProfiles: []},
            tenant_3: {id: 3, name: 'Root', username: 'root', role: 'superadmin', created_at: Date.now(), serviceProfiles: []}
        }
    };

    try {
        const req = {
            method: 'GET',
            url: '/stats/api/overview?service=relay',
            headers: {host: 'localhost'},
            socket: {remoteAddress: '127.0.0.1'}
        };
        const res = mockJsonResponse();

        assert.equal(await routeStatsRequest(req, res), true);
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.totalUsers, 2);
        assert.equal(body.activeUsers, 2);
        assert.equal(body.totalApiCalls, 15);
        assert.equal(body.cacheHitRate, 90);
        assert.deepEqual(body.allUsers.map(u => u.username), ['alice', 'bob']);
    } finally {
        TenantDailyUsage.findAll = originalFindAll;
        unifiedTenantManager.isEnabled = originalIsEnabled;
        unifiedTenantManager.registry = originalRegistry;
    }
});

test('stats monthly overview and model cache are scoped to the current user tenant', async () => {
    const originalFindAll = TenantDailyUsage.findAll;
    const originalIsEnabled = unifiedTenantManager.isEnabled;
    const originalRegistry = unifiedTenantManager.registry;
    const originalFindTenantByUsername = unifiedTenantManager.findTenantByUsername;
    const usageWheres = [];

    TenantDailyUsage.findAll = async (options = {}) => {
        if (options.where?.service_type === 'relay') usageWheres.push(options.where);
        return [];
    };
    unifiedTenantManager.findTenantByUsername = username => ({alice: 1, bob: 2}[username] ?? null);
    unifiedTenantManager.isEnabled = () => true;
    unifiedTenantManager.registry = {
        tenants: {
            tenant_1: {id: 1, name: 'Alice', username: 'alice', role: 'admin', created_at: Date.now(), serviceProfiles: []},
            tenant_2: {id: 2, name: 'Bob', username: 'bob', role: 'admin', created_at: Date.now(), serviceProfiles: []}
        }
    };

    try {
        const overviewReq = {
            method: 'GET',
            url: '/stats/api/overview?service=relay&month=2026-06',
            headers: adminHeaders('alice'),
            socket: {remoteAddress: '127.0.0.1'}
        };
        const overviewRes = mockJsonResponse();
        assert.equal(await routeStatsRequest(overviewReq, overviewRes), true);
        assert.equal(overviewRes.status, 200);

        const modelReq = {
            method: 'GET',
            url: '/stats/api/model-cache-stats?service=relay&startDate=2026-06-01&endDate=2026-06-30',
            headers: adminHeaders('alice'),
            socket: {remoteAddress: '127.0.0.1'}
        };
        const modelRes = mockJsonResponse();
        assert.equal(await routeStatsRequest(modelReq, modelRes), true);
        assert.equal(modelRes.status, 200);

        assert.ok(usageWheres.length >= 2);
        assert.ok(usageWheres.every(where => where.tenant_id === 1));
        assert.ok(usageWheres.some(where => Array.isArray(where.date?.[Op.between])
            && where.date[Op.between][0] === '2026-06-01'
            && where.date[Op.between][1] === '2026-06-30'));
    } finally {
        TenantDailyUsage.findAll = originalFindAll;
        unifiedTenantManager.isEnabled = originalIsEnabled;
        unifiedTenantManager.registry = originalRegistry;
        unifiedTenantManager.findTenantByUsername = originalFindTenantByUsername;
    }
});

test('stats APIs keep admin and superadmin scoped to their own tenant', async () => {
    const originalFindAll = TenantDailyUsage.findAll;
    const originalIsEnabled = unifiedTenantManager.isEnabled;
    const originalRegistry = unifiedTenantManager.registry;
    const originalFindTenantByUsername = unifiedTenantManager.findTenantByUsername;
    const usageWheres = [];

    TenantDailyUsage.findAll = async (options = {}) => {
        if (options.where?.service_type === 'relay') usageWheres.push(options.where);
        return [];
    };
    unifiedTenantManager.findTenantByUsername = username => ({alice: 1, bob: 2, root: 3}[username] ?? null);
    unifiedTenantManager.isEnabled = () => true;
    unifiedTenantManager.registry = {
        tenants: {
            tenant_1: {id: 1, name: 'Alice', username: 'alice', role: 'admin', created_at: Date.now(), serviceProfiles: []},
            tenant_2: {id: 2, name: 'Bob', username: 'bob', role: 'admin', created_at: Date.now(), serviceProfiles: []},
            tenant_3: {id: 3, name: 'Root', username: 'root', role: 'superadmin', created_at: Date.now(), serviceProfiles: []}
        }
    };

    try {
        const adminReq = {
            method: 'GET',
            url: '/stats/api/overview?service=relay',
            headers: sessionHeaders('alice', 'admin'),
            socket: {remoteAddress: '127.0.0.1'}
        };
        const adminRes = mockJsonResponse();
        assert.equal(await routeStatsRequest(adminReq, adminRes), true);
        assert.equal(adminRes.status, 200);

        const superAdminReq = {
            method: 'GET',
            url: '/stats/api/model-cache-stats?service=relay',
            headers: sessionHeaders('root', 'superadmin'),
            socket: {remoteAddress: '127.0.0.1'}
        };
        const superAdminRes = mockJsonResponse();
        assert.equal(await routeStatsRequest(superAdminReq, superAdminRes), true);
        assert.equal(superAdminRes.status, 200);

        const otherDetailReq = {
            method: 'GET',
            url: '/stats/api/user-detail?service=relay&username=bob',
            headers: sessionHeaders('alice', 'admin'),
            socket: {remoteAddress: '127.0.0.1'}
        };
        const otherDetailRes = mockJsonResponse();
        assert.equal(await routeStatsRequest(otherDetailReq, otherDetailRes), true);
        assert.equal(otherDetailRes.status, 403);

        assert.ok(usageWheres.some(where => where.tenant_id === 1));
        assert.ok(usageWheres.some(where => where.tenant_id === 3));
        assert.ok(usageWheres.every(where => where.tenant_id === 1 || where.tenant_id === 3));
    } finally {
        TenantDailyUsage.findAll = originalFindAll;
        unifiedTenantManager.isEnabled = originalIsEnabled;
        unifiedTenantManager.registry = originalRegistry;
        unifiedTenantManager.findTenantByUsername = originalFindTenantByUsername;
    }
});
