import {Op, fn, col} from 'sequelize';
import {TenantDailyUsage} from '../../db/models/tenant-daily-usage.js';
import {getAuthMode} from '../shared/auth-mode.js';
import logger from '../../utils/logger.js';
import {getGatewayStatsTenantEntries} from './stats-tenants.js';

const STATS_SERVICE_TYPES = new Set(['relay', 'codebuddy']);

function normalizeStatsService(serviceType) {
    return STATS_SERVICE_TYPES.has(serviceType) ? serviceType : 'codebuddy';
}

function toLocalDate(timestamp) {
    const value = typeof timestamp === 'number' && timestamp < 100000000000
        ? timestamp * 1000
        : timestamp;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'N/A';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function currentAuthMode() {
    try {
        return getAuthMode();
    } catch {
        return 'local';
    }
}

function isStatsTenantIncluded(tenant) {
    return !(currentAuthMode() === 'local' && tenant?.role === 'superadmin');
}

function isStatsTenantVisibleInScope(tenant, tenantId) {
    if (tenantId) return tenant?.id === tenantId;
    return isStatsTenantIncluded(tenant);
}

function buildDateRangeWhere(startDate, endDate) {
    const where = {};
    if (startDate && endDate) where.date = {[Op.between]: [startDate, endDate]};
    else if (startDate) where.date = {[Op.gte]: startDate};
    else if (endDate) where.date = {[Op.lte]: endDate};
    return where;
}

async function getStatsTenantEntries(tenantManager) {
    return getGatewayStatsTenantEntries(tenantManager);
}

async function getExcludedStatsTenantIds(tenantManager) {
    if (currentAuthMode() !== 'local') return [];
    return (await getStatsTenantEntries(tenantManager))
        .filter(([, tenant]) => tenant?.role === 'superadmin')
        .map(([, tenant]) => tenant.id)
        .filter(id => id !== undefined && id !== null);
}

async function buildStatsUsageWhere(tenantManager, service, startDate, endDate, extra = {}) {
    const where = {service_type: service, ...buildDateRangeWhere(startDate, endDate), ...extra};
    const excludedTenantIds = await getExcludedStatsTenantIds(tenantManager);
    if (excludedTenantIds.length > 0) {
        if (where.tenant_id) {
            return where;
        } else {
            where.tenant_id = {[Op.notIn]: excludedTenantIds};
        }
    }
    return where;
}

async function getMonthlyStats(tenantManager, serviceType = 'codebuddy', tenantId, startDate, endDate) {
    const monthlyStats = {};
    const service = normalizeStatsService(serviceType);

    if (!tenantManager.isEnabled()) {
        return monthlyStats;
    }

    try {
        const rows = await TenantDailyUsage.findAll({
            attributes: [
                [fn('SUBSTRING', col('date'), 1, 7), 'month'],
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: await buildStatsUsageWhere(tenantManager, service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {}),
            group: [fn('SUBSTRING', col('date'), 1, 7)],
            raw: true
        });

        for (const row of rows) {
            monthlyStats[row.month] = {
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens: parseInt(row.inputTokens) || 0,
                outputTokens: parseInt(row.outputTokens) || 0,
                cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('读取月度统计数据失败:', error.message);
    }

    return monthlyStats;
}

async function getMonthlyTrendData(tenantManager, serviceType = 'codebuddy', tenantId, startDate, endDate) {
    const monthlyStats = await getMonthlyStats(tenantManager, serviceType, tenantId, startDate, endDate);
    const sortedMonths = Object.keys(monthlyStats).sort();

    return sortedMonths.map((month) => ({
        month,
        apiCalls: monthlyStats[month].apiCalls,
        inputTokens: monthlyStats[month].inputTokens,
        outputTokens: monthlyStats[month].outputTokens,
        totalTokens: monthlyStats[month].inputTokens + monthlyStats[month].outputTokens
    }));
}

async function getModelCacheStats(tenantManager, serviceType = 'codebuddy', startDate, endDate, tenantId) {
    if (!tenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(tenantManager, service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'model',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where,
            group: ['model'],
            order: [[fn('SUM', col('input_tokens')), 'DESC']],
            raw: true
        });

        return rows.map((row) => {
            const inputTokens = parseInt(row.inputTokens) || 0;
            const cacheHitTokens = parseInt(row.cacheHitTokens) || 0;
            const outputTokens = parseInt(row.outputTokens) || 0;
            return {
                model: row.model || 'unknown',
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens,
                inputHitTokens: cacheHitTokens,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                cacheHitTokens,
                cacheHitRate: inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0,
                credit: parseFloat(row.credit) || 0
            };
        });
    } catch (error) {
        logger.error('读取模型缓存统计数据失败:', error.message);
        return [];
    }
}

async function getModelCacheDailyTrend(tenantManager, serviceType = 'codebuddy', model, startDate, endDate, tenantId) {
    if (!tenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(tenantManager, service, startDate, endDate, {model, ...(tenantId ? {tenant_id: tenantId} : {})});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'date',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
            ],
            where,
            group: ['date'],
            order: [['date', 'ASC']],
            raw: true
        });

        return rows.map((row) => {
            const inputTokens = parseInt(row.inputTokens) || 0;
            const cacheHitTokens = parseInt(row.cacheHitTokens) || 0;
            return {
                date: row.date,
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens,
                cacheHitTokens,
                cacheHitRate: inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0
            };
        });
    } catch (error) {
        logger.error('读取模型每日缓存趋势失败:', error.message);
        return [];
    }
}

async function getDailyTrendData(tenantManager, serviceType = 'codebuddy', tenantId) {
    if (!tenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'date',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: await buildStatsUsageWhere(tenantManager, service, undefined, undefined, tenantId ? {tenant_id: tenantId} : {}),
            group: ['date'],
            order: [['date', 'ASC']],
            raw: true
        });

        return rows.map((row) => ({
            date: row.date,
            apiCalls: parseInt(row.apiCalls) || 0,
            inputTokens: parseInt(row.inputTokens) || 0,
            outputTokens: parseInt(row.outputTokens) || 0,
            totalTokens: (parseInt(row.inputTokens) || 0) + (parseInt(row.outputTokens) || 0),
            cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
            cacheHitRate:
                parseInt(row.inputTokens) > 0
                    ? Math.round((parseInt(row.cacheHitTokens) / parseInt(row.inputTokens)) * 100)
                    : 0,
            credit: parseFloat(row.credit) || 0
        }));
    } catch (error) {
        logger.error('读取每日趋势数据失败:', error.message);
        return [];
    }
}

async function getUserTrendData(tenantManager, serviceType = 'codebuddy', tenantId) {
    if (!tenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    const tenants = (await getStatsTenantEntries(tenantManager))
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));

    const newUsersByDate = {};
    tenants.forEach(([, t]) => {
        if (t.created_at) {
            const d = toLocalDate(t.created_at);
            newUsersByDate[d] = (newUsersByDate[d] || 0) + 1;
        }
    });

    const activeUsersByDate = {};
    try {
        const activeRows = await TenantDailyUsage.findAll({
            attributes: ['date', [fn('COUNT', fn('DISTINCT', col('tenant_id'))), 'activeCount']],
            where: await buildStatsUsageWhere(tenantManager, service, undefined, undefined, {api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['date'],
            raw: true
        });

        for (const row of activeRows) {
            activeUsersByDate[row.date] = parseInt(row.activeCount) || 0;
        }
    } catch (error) {
        logger.error('读取活跃用户趋势数据失败:', error.message);
    }

    const allDates = [...new Set([...Object.keys(newUsersByDate), ...Object.keys(activeUsersByDate)])].sort();

    let cumulativeUsers = 0;
    return allDates.map((date) => {
        cumulativeUsers += newUsersByDate[date] || 0;
        return {
            date,
            newUsers: newUsersByDate[date] || 0,
            totalUsers: cumulativeUsers,
            activeUsers: activeUsersByDate[date] || 0
        };
    });
}

async function getOverviewStats(tenantManager, serviceType = 'codebuddy', startDate, endDate, tenantId) {
    if (!tenantManager.isEnabled()) {
        return {
            totalUsers: 0,
            activeUsers: 0,
            totalApiCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            tenantsWithCreds: 0,
            totalCreds: 0,
            topUsers: [],
            allUsers: [],
            monthlyStats: {}
        };
    }
    const service = normalizeStatsService(serviceType);

    const tenants = (await getStatsTenantEntries(tenantManager))
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));
    const usageWhere = await buildStatsUsageWhere(tenantManager, service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {});
    let tenantsWithCreds = 0;
    let totalCreds = 0;

    const usageMap = {};
    try {
        const usageRows = await TenantDailyUsage.findAll({
            attributes: [
                'tenant_id',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('input_cache_miss')), 'inputMissTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: usageWhere,
            group: ['tenant_id'],
            raw: true
        });
        for (const row of usageRows) {
            usageMap[row.tenant_id] = {
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens: parseInt(row.inputTokens) || 0,
                outputTokens: parseInt(row.outputTokens) || 0,
                cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
                inputMissTokens: parseInt(row.inputMissTokens) || 0,
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('从每日用量聚合租户统计失败:', error.message);
    }

    const lastActiveMap = {};
    try {
        const lastActiveRows = await TenantDailyUsage.findAll({
            attributes: ['tenant_id', [fn('MAX', col('date')), 'lastActiveDate']],
            where: await buildStatsUsageWhere(tenantManager, service, undefined, undefined, {api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['tenant_id'],
            raw: true
        });
        for (const row of lastActiveRows) {
            lastActiveMap[row.tenant_id] = row.lastActiveDate;
        }
    } catch (error) {
        logger.error('批量查询最后活跃日期失败:', error.message);
    }

    let totalUsers = 0;
    let activeUsers = 0;
    let totalApiCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheHitTokens = 0;
    let totalCredit = 0;
    let cacheHitRateTotal = 0;
    let cacheHitRateUsers = 0;

    const users = tenants.map(([tenantKey, tenant]) => {
        totalUsers++;
        const usage = usageMap[tenant.id] || {
            apiCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
            inputMissTokens: 0,
            credit: 0
        };
        const apiCalls = usage.apiCalls;
        const inputTokens = usage.inputTokens;
        const outputTokens = usage.outputTokens;
        const cacheHitTokens = usage.cacheHitTokens;
        const inputMissTokens = usage.inputMissTokens;
        const credit = usage.credit;
        const totalTokens = inputTokens + outputTokens;
        const credCount = tenant.credential_count || 0;
        const createdAt = tenant.created_at ? toLocalDate(tenant.created_at) : 'N/A';
        const lastActiveDate = lastActiveMap[tenant.id] || 'N/A';
        const cacheHitRate = inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0;

        if (apiCalls > 0) activeUsers++;
        totalApiCalls += apiCalls;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheHitTokens += cacheHitTokens;
        totalCredit += credit;
        if (cacheHitTokens > 0) {
            cacheHitRateTotal += cacheHitRate;
            cacheHitRateUsers++;
        }
        if (credCount > 0) tenantsWithCreds++;
        totalCreds += credCount;

        return {
            tenantId: tenantKey,
            name: tenant.name || '未命名',
            username: tenant.username || 'N/A',
            apiCalls,
            inputTokens,
            outputTokens,
            inputHitTokens: cacheHitTokens,
            inputMissTokens,
            totalTokens,
            cacheHitTokens,
            cacheHitRate,
            credit,
            credCount,
            createdAt,
            lastActiveDate,
            status: apiCalls > 0 ? 'active' : 'inactive'
        };
    });

    const topUsers = users.sort((a, b) => b.apiCalls - a.apiCalls).slice(0, 50);

    const monthlyStats = await getMonthlyStats(tenantManager, service, tenantId, startDate, endDate);

    return {
        totalUsers,
        activeUsers,
        totalApiCalls,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCacheHitTokens,
        cacheHitRate: cacheHitRateUsers > 0 ? Math.round(cacheHitRateTotal / cacheHitRateUsers) : 0,
        cacheHitRateUsers,
        totalCredit,
        tenantsWithCreds,
        totalCreds,
        topUsers,
        allUsers: users.map((u) => ({
            name: u.name,
            username: u.username,
            apiCalls: u.apiCalls,
            inputTokens: u.inputTokens,
            inputHitTokens: u.inputHitTokens,
            inputMissTokens: u.inputMissTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            cacheHitTokens: u.cacheHitTokens,
            cacheHitRate: u.cacheHitRate,
            credit: u.credit,
            createdAt: u.createdAt,
            lastActiveDate: u.lastActiveDate,
            status: u.status
        })),
        monthlyStats
    };
}

async function getDailyUserLists(tenantManager, serviceType = 'codebuddy', date, tenantId) {
    if (!tenantManager.isEnabled()) {
        return {newUsers: [], activeUsers: []};
    }
    const service = normalizeStatsService(serviceType);

    const tenants = (await getStatsTenantEntries(tenantManager))
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));

    const newUsers = [];
    for (const [, tenant] of tenants) {
        if (tenant.created_at) {
            const d = toLocalDate(tenant.created_at);
            if (d === date) {
                newUsers.push({
                    name: tenant.name || '未命名',
                    username: tenant.username || 'N/A'
                });
            }
        }
    }

    const activeUsers = [];
    try {
        const activeRows = await TenantDailyUsage.findAll({
            attributes: ['tenant_id', [fn('SUM', col('api_calls')), 'totalCalls']],
            where: await buildStatsUsageWhere(tenantManager, service, undefined, undefined, {date, api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['tenant_id'],
            raw: true
        });

        const tenantMap = {};
        for (const [, t] of tenants) {
            tenantMap[t.id] = t;
        }

        const activeTenantIds = activeRows.map((r) => r.tenant_id);
        const activeDatesMap = {};
        if (activeTenantIds.length > 0) {
            try {
                const streakRows = await TenantDailyUsage.findAll({
                    attributes: ['tenant_id', 'date', [fn('SUM', col('api_calls')), 'totalCalls']],
                    where: await buildStatsUsageWhere(tenantManager, service, undefined, undefined, {tenant_id: {[Op.in]: activeTenantIds}}),
                    group: ['tenant_id', 'date'],
                    raw: true
                });
                for (const row of streakRows) {
                    if (parseInt(row.totalCalls) > 0) {
                        if (!activeDatesMap[row.tenant_id]) activeDatesMap[row.tenant_id] = [];
                        activeDatesMap[row.tenant_id].push(row.date);
                    }
                }
            } catch (error) {
                logger.error('批量查询活跃日期失败:', error.message);
            }
        }

        for (const row of activeRows) {
            const t = tenantMap[row.tenant_id];
            if (t) {
                activeUsers.push({
                    name: t.name || '未命名',
                    username: t.username || 'N/A',
                    apiCalls: parseInt(row.totalCalls) || 0,
                    activeDates: activeDatesMap[row.tenant_id] || []
                });
            }
        }
    } catch (error) {
        logger.error('查询日活用户失败:', error.message);
    }

    activeUsers.sort((a, b) => b.apiCalls - a.apiCalls);

    return {newUsers, activeUsers};
}

async function getUserDetail(tenantManager, serviceType = 'codebuddy', username) {
    if (!tenantManager.isEnabled()) {
        return {
            username,
            totalApiCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            dailyData: {}
        };
    }
    const service = normalizeStatsService(serviceType);

    let tenantId = null;
    let tenantData = null;

    for (const [, tenant] of await getStatsTenantEntries(tenantManager)) {
        if (tenant.username === username) {
            tenantId = tenant.id;
            tenantData = tenant;
            break;
        }
    }

    if (!tenantId || !tenantData) {
        return {
            username,
            totalApiCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            dailyData: {}
        };
    }

    const dailyData = {};
    let totalApiCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    try {
        const usageRows = await TenantDailyUsage.findAll({
            where: {
                tenant_id: tenantId,
                service_type: service
            },
            order: [['date', 'ASC']],
            raw: true
        });

        for (const row of usageRows) {
            const month = row.date.slice(0, 7);
            const day = parseInt(row.date.slice(8, 10), 10);
            if (!dailyData[month]) {
                dailyData[month] = {};
            }
            if (!dailyData[month][day]) {
                dailyData[month][day] = {
                    api_calls: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_hit_tokens: 0,
                    cache_miss_tokens: 0,
                    credit: 0
                };
            }
            dailyData[month][day].api_calls += row.api_calls || 0;
            dailyData[month][day].input_tokens += row.input_tokens || 0;
            dailyData[month][day].output_tokens += row.output_tokens || 0;
            dailyData[month][day].cache_hit_tokens += row.input_cache_hit || 0;
            dailyData[month][day].cache_miss_tokens += row.input_cache_miss || 0;
            dailyData[month][day].credit += row.credit || 0;
            totalApiCalls += row.api_calls || 0;
            totalInputTokens += row.input_tokens || 0;
            totalOutputTokens += row.output_tokens || 0;
        }
    } catch (error) {
        logger.error(`读取用户 ${username} 每日数据失败:`, error.message);
    }

    return {
        username,
        name: tenantData.name || username,
        totalApiCalls,
        totalInputTokens,
        totalOutputTokens,
        dailyData
    };
}

export function createGatewayStatsUsageService({tenantManager} = {}) {
    return {
        getStatsTenantEntries() {
            return getStatsTenantEntries(tenantManager);
        },
        getOverviewStats(serviceType, startDate, endDate, tenantId) {
            return getOverviewStats(tenantManager, serviceType, startDate, endDate, tenantId);
        },
        getMonthlyTrendData(serviceType, tenantId, startDate, endDate) {
            return getMonthlyTrendData(tenantManager, serviceType, tenantId, startDate, endDate);
        },
        getUserTrendData(serviceType, tenantId) {
            return getUserTrendData(tenantManager, serviceType, tenantId);
        },
        getModelCacheStats(serviceType, startDate, endDate, tenantId) {
            return getModelCacheStats(tenantManager, serviceType, startDate, endDate, tenantId);
        },
        getModelCacheDailyTrend(serviceType, model, startDate, endDate, tenantId) {
            return getModelCacheDailyTrend(tenantManager, serviceType, model, startDate, endDate, tenantId);
        },
        getDailyTrendData(serviceType, tenantId) {
            return getDailyTrendData(tenantManager, serviceType, tenantId);
        },
        getDailyUserLists(serviceType, date, tenantId) {
            return getDailyUserLists(tenantManager, serviceType, date, tenantId);
        },
        getUserDetail(serviceType, username) {
            return getUserDetail(tenantManager, serviceType, username);
        }
    };
}
