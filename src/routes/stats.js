/**
 * 统计页面路由
 * 提供系统使用统计的可视化展示
 * @module routes/stats
 */

import {Op, fn, col} from 'sequelize';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';
import {getSessionUser} from '../services/gateway/session.js';
import {TenantDailyUsage} from '../db/models/tenant-daily-usage.js';
import {models} from '../db/models/index.js';
import {runAnalysis, runBatchAnalysis, getSampleCount, getSamples} from '../services/coach/index.js';
import {getAuthMode} from '../services/shared/auth-mode.js';
import logger from '../utils/logger.js';

/**
 * 发送JSON响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 发送HTML响应
 */
function isStatsAdmin(req) {
    const session = getSessionUser(req);
    if (!session.authenticated) return false;
    return session.role === 'admin' || session.role === 'superadmin' || unifiedTenantManager.isAdmin?.(session.username);
}

function requireStatsAdmin(req, res) {
    sendJson(res, 403, {error: 'Only own usage statistics are available'});
    return false;
}

/**
 * 秒级时间戳转本地日期字符串 (YYYY-MM-DD)
 */
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

/**
 * 格式化数字
 */
function formatNumber(num) {
    if (num === undefined || num === null) return 0;
    return num;
}

const STATS_SERVICE_TYPES = new Set(['relay', 'codebuddy', 'copilot']);
const EMPTY_STATS_TENANT_ID = -1;

function normalizeStatsService(serviceType) {
    return STATS_SERVICE_TYPES.has(serviceType) ? serviceType : 'codebuddy';
}

function getStatsService(url) {
    return normalizeStatsService(url.searchParams.get('service') || 'codebuddy');
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

function monthDateRange(month) {
    if (!/^\d{4}-\d{2}$/.test(month || '')) return {};
    const [year, monthNo] = month.split('-').map(Number);
    const lastDay = new Date(year, monthNo, 0).getDate();
    return {
        startDate: month + '-01',
        endDate: `${month}-${String(lastDay).padStart(2, '0')}`
    };
}

function resolveDateRange(url) {
    const monthRange = monthDateRange(url.searchParams.get('month'));
    return {
        startDate: monthRange.startDate || url.searchParams.get('startDate'),
        endDate: monthRange.endDate || url.searchParams.get('endDate')
    };
}

async function getCurrentStatsTenantId(req) {
    const session = getSessionUser(req);
    if (!session.authenticated || !session.username) return null;
    const cachedTenantId = unifiedTenantManager.findTenantByUsername?.(session.username);
    if (cachedTenantId !== undefined && cachedTenantId !== null) return cachedTenantId;
    const entry = (await getStatsTenantEntries()).find(([, tenant]) => tenant?.username === session.username);
    return entry?.[1]?.id || EMPTY_STATS_TENANT_ID;
}

async function getExcludedStatsTenantIds() {
    if (currentAuthMode() !== 'local') return [];
    return (await getStatsTenantEntries())
        .filter(([, tenant]) => tenant?.role === 'superadmin')
        .map(([, tenant]) => tenant.id)
        .filter(id => id !== undefined && id !== null);
}

async function buildStatsUsageWhere(service, startDate, endDate, extra = {}) {
    const where = {service_type: service, ...buildDateRangeWhere(startDate, endDate), ...extra};
    const excludedTenantIds = await getExcludedStatsTenantIds();
    if (excludedTenantIds.length > 0) {
        if (where.tenant_id) {
            return where;
        } else {
            where.tenant_id = {[Op.notIn]: excludedTenantIds};
        }
    }
    return where;
}

async function getStatsTenantEntries() {
    if (unifiedTenantManager.registry?.tenants) {
        return Object.entries(unifiedTenantManager.registry.tenants);
    }

    const tenants = unifiedTenantManager.tenantsCache instanceof Map
        ? Array.from(unifiedTenantManager.tenantsCache.values())
        : [];

    const credentialCounts = new Map();
    if (tenants.length > 0) {
        const rows = await models.TenantCredential.findAll({
            attributes: ['tenant_id', [fn('COUNT', col('id')), 'credentialCount']],
            group: ['tenant_id'],
            raw: true
        });
        for (const row of rows) {
            credentialCounts.set(Number(row.tenant_id), parseInt(row.credentialCount, 10) || 0);
        }
    }

    return tenants.map((tenant) => {
        const codebuddyProfile = (tenant.serviceProfiles || []).find((profile) => profile.service_type === 'codebuddy') || {};
        return [
            `tenant_${tenant.id}`,
            {
                ...tenant,
                credential_count: credentialCounts.get(Number(tenant.id)) || 0,
                total_api_calls: codebuddyProfile.total_api_calls || tenant.total_api_calls || 0,
                total_input_tokens: codebuddyProfile.total_input_tokens || tenant.total_input_tokens || 0,
                total_output_tokens: codebuddyProfile.total_output_tokens || tenant.total_output_tokens || 0,
                total_cache_hit_tokens: codebuddyProfile.total_cache_hit_tokens || tenant.total_cache_hit_tokens || 0,
                total_credit: codebuddyProfile.total_credit || tenant.total_credit || 0,
                is_key_personnel: !!tenant.is_key_personnel
            }
        ];
    });
}

function syncKeyPersonnelCache(username, isKeyPersonnel) {
    const key = !!isKeyPersonnel;
    if (unifiedTenantManager.registry?.tenants) {
        for (const tenant of Object.values(unifiedTenantManager.registry.tenants)) {
            if (tenant.username === username) {
                tenant.is_key_personnel = key;
                return;
            }
        }
    }

    if (unifiedTenantManager.tenantsCache instanceof Map) {
        for (const tenant of unifiedTenantManager.tenantsCache.values()) {
            if (tenant.username === username) {
                tenant.is_key_personnel = key;
                return;
            }
        }
    }
}

/**
 * 获取月度统计数据
 */
async function getMonthlyStats(serviceType = 'codebuddy', tenantId, startDate, endDate) {
    const monthlyStats = {};
    const service = normalizeStatsService(serviceType);

    if (!unifiedTenantManager.isEnabled()) {
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
                [fn('SUM', col('credit')), 'credit']
            ],
            where: await buildStatsUsageWhere(service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {}),
            group: [fn('SUBSTRING', col('date'), 1, 7)],
            raw: true
        });

        for (const row of rows) {
            monthlyStats[row.month] = {
                apiCalls: parseInt(row.apiCalls) || 0,
                inputTokens: parseInt(row.inputTokens) || 0,
                outputTokens: parseInt(row.outputTokens) || 0,
                cacheHitTokens: parseInt(row.cacheHitTokens) || 0,
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('读取月度统计数据失败:', error.message);
    }

    return monthlyStats;
}

/**
 * 获取月度趋势数据（用于图表）
 */
async function getMonthlyTrendData(serviceType = 'codebuddy', tenantId, startDate, endDate) {
    const monthlyStats = await getMonthlyStats(serviceType, tenantId, startDate, endDate);

    // 按月份排序
    const sortedMonths = Object.keys(monthlyStats).sort();

    const trendData = sortedMonths.map((month) => ({
        month,
        apiCalls: monthlyStats[month].apiCalls,
        inputTokens: monthlyStats[month].inputTokens,
        outputTokens: monthlyStats[month].outputTokens,
        totalTokens: monthlyStats[month].inputTokens + monthlyStats[month].outputTokens
    }));

    return trendData;
}

/**
 * 获取模型缓存命中统计数据（按模型分组）
 * @param {string} [startDate] - 可选，起始日期 YYYY-MM-DD
 * @param {string} [endDate] - 可选，结束日期 YYYY-MM-DD
 */
async function getModelCacheStats(serviceType = 'codebuddy', startDate, endDate, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'model',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
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
                inputMissTokens: Math.max(0, inputTokens - cacheHitTokens),
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

/**
 * 获取单个模型的每日缓存命中率趋势
 * @param {string} model - 模型名称
 * @param {string} [startDate] - 可选，起始日期 YYYY-MM-DD
 * @param {string} [endDate] - 可选，结束日期 YYYY-MM-DD
 */
async function getModelCacheDailyTrend(serviceType = 'codebuddy', model, startDate, endDate, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    try {
        const where = await buildStatsUsageWhere(service, startDate, endDate, {model, ...(tenantId ? {tenant_id: tenantId} : {})});

        const rows = await TenantDailyUsage.findAll({
            attributes: [
                'date',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens']
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

/**
 * 获取每日趋势数据（全局汇总，按日期）
 */
async function getDailyTrendData(serviceType = 'codebuddy', tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
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
            where: await buildStatsUsageWhere(service, undefined, undefined, tenantId ? {tenant_id: tenantId} : {}),
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

/**
 * 获取用户趋势数据（每日累计用户数 + 每日活跃用户数）
 */
async function getUserTrendData(serviceType = 'codebuddy', tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return [];
    }
    const service = normalizeStatsService(serviceType);

    const tenants = (await getStatsTenantEntries())
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));

    // 按注册日期统计新增用户
    const newUsersByDate = {};
    tenants.forEach(([, t]) => {
        if (t.created_at) {
            const d = toLocalDate(t.created_at);
            newUsersByDate[d] = (newUsersByDate[d] || 0) + 1;
        }
    });

    // 按日期统计活跃用户数（从数据库查询）
    const activeUsersByDate = {};
    try {
        const activeRows = await TenantDailyUsage.findAll({
            attributes: ['date', [fn('COUNT', fn('DISTINCT', col('tenant_id'))), 'activeCount']],
            where: await buildStatsUsageWhere(service, undefined, undefined, {api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['date'],
            raw: true
        });

        for (const row of activeRows) {
            activeUsersByDate[row.date] = parseInt(row.activeCount) || 0;
        }
    } catch (error) {
        logger.error('读取活跃用户趋势数据失败:', error.message);
    }

    // 合并所有日期并排序
    const allDates = [...new Set([...Object.keys(newUsersByDate), ...Object.keys(activeUsersByDate)])].sort();

    // 构建趋势数据（累计用户数）
    let cumulativeUsers = 0;
    const trendData = allDates.map((date) => {
        cumulativeUsers += newUsersByDate[date] || 0;
        return {
            date,
            newUsers: newUsersByDate[date] || 0,
            totalUsers: cumulativeUsers,
            activeUsers: activeUsersByDate[date] || 0
        };
    });

    return trendData;
}

/**
 * 获取统计概览数据
 */
async function getOverviewStats(serviceType = 'codebuddy', startDate, endDate, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
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

    const tenants = (await getStatsTenantEntries())
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));
    const usageWhere = await buildStatsUsageWhere(service, startDate, endDate, tenantId ? {tenant_id: tenantId} : {});
    let tenantsWithCreds = 0;
    let totalCreds = 0;

    // 从 TenantDailyUsage 聚合每个租户的历史总量（不受重置影响）
    const usageMap = {};
    try {
        const usageRows = await TenantDailyUsage.findAll({
            attributes: [
                'tenant_id',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
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
                credit: parseFloat(row.credit) || 0
            };
        }
    } catch (error) {
        logger.error('从每日用量聚合租户统计失败:', error.message);
    }

    // 批量查询所有租户的最后活跃日期
    const lastActiveMap = {};
    try {
        const lastActiveRows = await TenantDailyUsage.findAll({
            attributes: ['tenant_id', [fn('MAX', col('date')), 'lastActiveDate']],
            where: await buildStatsUsageWhere(service, undefined, undefined, {api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['tenant_id'],
            raw: true
        });
        for (const row of lastActiveRows) {
            lastActiveMap[row.tenant_id] = row.lastActiveDate;
        }
    } catch (error) {
        logger.error('查询最后活跃日期失败:', error.message);
    }

    let totalApiCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheHitTokens = 0;
    let totalCredit = 0;
    let activeUsers = 0;
    let cacheHitRateUsers = 0;
    let cacheHitRateTotal = 0;

    const users = tenants.map(([tenantId, tenant]) => {
        const usage = usageMap[tenant.id] || {
            apiCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheHitTokens: 0,
            credit: 0
        };
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const credCount = tenant.credential_count || 0;

        // 注册时间（从时间戳转换）
        const createdAt = tenant.created_at ? toLocalDate(tenant.created_at) : 'N/A';

        // 最后活跃时间（从数据库查询）
        const lastActiveDate = lastActiveMap[tenant.id] || 'N/A';

        totalApiCalls += usage.apiCalls;
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        totalCacheHitTokens += usage.cacheHitTokens;
        totalCredit += usage.credit;
        if (usage.apiCalls > 0) activeUsers++;
        if (usage.inputTokens > 0 && usage.cacheHitTokens > 0) {
            cacheHitRateUsers++;
            cacheHitRateTotal += Math.round((usage.cacheHitTokens / usage.inputTokens) * 100);
        }
        if (credCount > 0) tenantsWithCreds++;
        totalCreds += credCount;

        return {
            tenantId,
            name: tenant.name || '未命名',
            username: tenant.username || 'N/A',
            apiCalls: usage.apiCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputHitTokens: usage.cacheHitTokens,
            inputMissTokens: Math.max(0, usage.inputTokens - usage.cacheHitTokens),
            totalTokens,
            cacheHitTokens: usage.cacheHitTokens,
            cacheHitRate: usage.inputTokens > 0 ? Math.round((usage.cacheHitTokens / usage.inputTokens) * 100) : 0,
            credit: usage.credit,
            credCount,
            createdAt,
            lastActiveDate,
            status: usage.apiCalls > 0 ? 'active' : 'inactive'
        };
    });

    // 按调用次数排序取前50
    const topUsers = users.sort((a, b) => b.apiCalls - a.apiCalls).slice(0, 50);

    const monthlyStats = await getMonthlyStats(service, tenantId, startDate, endDate);

    return {
        totalUsers: tenants.length,
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

/**
 * 服务统计页面HTML
 */
/**
 * 处理API请求
 */
async function handleApiRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 概览统计API
    if (pathname === '/stats/api/overview' && req.method === 'GET') {
        const service = getStatsService(url);
        const {startDate, endDate} = resolveDateRange(url);
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const stats = await getOverviewStats(service, startDate, endDate, tenantId);

            const activeRate = stats.totalUsers > 0 ? Math.round((stats.activeUsers / stats.totalUsers) * 100) : 0;

            const avgTokensPerCall = stats.totalApiCalls > 0 ? Math.round(stats.totalTokens / stats.totalApiCalls) : 0;

            sendJson(res, 200, {
                totalUsers: stats.totalUsers,
                activeUsers: stats.activeUsers,
                activeRate,
                totalApiCalls: stats.totalApiCalls,
                totalTokens: stats.totalTokens,
                totalCacheHitTokens: stats.totalCacheHitTokens,
                cacheHitRate: stats.cacheHitRate,
                totalCredit: stats.totalCredit,
                avgTokensPerCall,
                tenantsWithCreds: stats.tenantsWithCreds,
                totalCreds: stats.totalCreds,
                topUsers: stats.topUsers.map((u) => ({
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
                    credit: u.credit
                })),
                allUsers: stats.allUsers,
                monthlyStats: stats.monthlyStats,
                monthlyTrend: await getMonthlyTrendData(service, tenantId, startDate, endDate),
                userTrend: await getUserTrendData(service, tenantId)
            });
        } catch (error) {
            logger.error('获取统计数据失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 模型缓存命中统计API
    if (pathname === '/stats/api/model-cache-stats' && req.method === 'GET') {
        const service = getStatsService(url);
        const {startDate, endDate} = resolveDateRange(url);
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await getModelCacheStats(service, startDate, endDate, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取模型缓存统计失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 模型每日缓存命中率趋势API
    if (pathname === '/stats/api/model-cache-daily' && req.method === 'GET') {
        const service = getStatsService(url);
        const model = url.searchParams.get('model');
        const {startDate, endDate} = resolveDateRange(url);
        if (!model) {
            sendJson(res, 400, {error: '缺少 model 参数'});
            return true;
        }
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await getModelCacheDailyTrend(service, model, startDate, endDate, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取模型每日缓存趋势失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 每日趋势数据API
    if (pathname === '/stats/api/daily-trend' && req.method === 'GET') {
        const service = getStatsService(url);
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await getDailyTrendData(service, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取每日趋势数据失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 每日用户列表API
    if (pathname === '/stats/api/daily-users' && req.method === 'GET') {
        const service = getStatsService(url);
        const date = url.searchParams.get('date');
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            sendJson(res, 400, {error: '缺少有效的 date 参数（格式：YYYY-MM-DD）'});
            return true;
        }

        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await getDailyUserLists(service, date, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取每日用户列表失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 用户详情API
    if (pathname === '/stats/api/user-detail' && req.method === 'GET') {
        const service = getStatsService(url);
        const username = url.searchParams.get('username');
        if (!username) {
            sendJson(res, 400, {error: '缺少 username 参数'});
            return true;
        }

        try {
            const session = getSessionUser(req);
            if (session.authenticated && username !== session.username) {
                sendJson(res, 403, {error: 'Only own usage detail is available'});
                return true;
            }
            const userDetail = await getUserDetail(service, username);
            sendJson(res, 200, userDetail);
        } catch (error) {
            logger.error('获取用户详情失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 重点人员列表API
    if (pathname === '/stats/api/key-personnel' && req.method === 'GET') {
        if (!requireStatsAdmin(req, res)) return true;
        const service = getStatsService(url);
        try {
            const data = await getKeyPersonnelList(service);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取重点人员列表失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 标记/取消标记重点人员
    if (pathname === '/stats/api/key-personnel' && req.method === 'POST') {
        if (!requireStatsAdmin(req, res)) return true;
        try {
            const body = await parseRequestBody(req);
            await toggleKeyPersonnel(body);
            sendJson(res, 200, {success: true});
        } catch (error) {
            logger.error('标记重点人员失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 获取用户AI评估报告
    if (pathname === '/stats/api/coach-assessment' && req.method === 'GET') {
        if (!requireStatsAdmin(req, res)) return true;
        const service = getStatsService(url);
        const username = url.searchParams.get('username');
        if (!username) {
            sendJson(res, 400, {error: '缺少 username 参数'});
            return true;
        }
        try {
            const data = await getCoachAssessment(username, service);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取AI评估报告失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 获取用户采样数据
    if (pathname === '/stats/api/coach-samples' && req.method === 'GET') {
        if (!requireStatsAdmin(req, res)) return true;
        const service = getStatsService(url);
        const username = url.searchParams.get('username');
        const period = url.searchParams.get('period') || getCurrentPeriod();
        if (!username) {
            sendJson(res, 400, {error: '缺少 username 参数'});
            return true;
        }
        try {
            const tenant = await models.Tenant.findOne({
                where: {username},
                attributes: ['id'],
                raw: true
            });
            if (!tenant) {
                sendJson(res, 200, {username, samples: []});
                return true;
            }
            const samples = (await getSamples('tenant_' + tenant.id, period))
                .filter((sample) => !sample.service_type || sample.service_type === service);
            // 文件样本已被清理时，从数据库元数据补充概要
            if (samples.length === 0) {
                const startDate = period + '-01';
                const endDate = period + '-31';
                const dbSamples = await models.ApiSample.findAll({
                    where: {
                        tenant_id: tenant.id,
                        service_type: service,
                        created_at: {gte: startDate, lte: endDate}
                    },
                    order: [['created_at', 'ASC']],
                    raw: true
                });
                const metaSamples = dbSamples.map(s => ({
                    tenant_id: s.tenant_id,
                    username: s.username,
                    service_type: s.service_type,
                    model: s.model,
                    timestamp: s.created_at,
                    request_tokens: s.request_tokens,
                    response_tokens: s.response_tokens,
                    _fromDb: true
                }));
                sendJson(res, 200, {username, period, count: metaSamples.length, samples: metaSamples, fromDb: true});
                return true;
            }
            sendJson(res, 200, {username, period, count: samples.length, samples});
        } catch (error) {
            logger.error('获取采样数据失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    // 手动触发AI分析
    if (pathname === '/stats/api/coach-trigger' && req.method === 'POST') {
        if (!requireStatsAdmin(req, res)) return true;
        const service = getStatsService(url);
        try {
            const body = await parseRequestBody(req);
            const result = await triggerCoachAnalysis(body.username, service);
            sendJson(res, 200, {success: true, ...result});
        } catch (error) {
            logger.error('触发AI分析失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    return false;
}

/**
 * 解析 POST 请求体
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 获取重点人员列表（含所有用户的 is_key_personnel 状态）
 */
async function getKeyPersonnelList(serviceType = 'codebuddy') {
    const service = normalizeStatsService(serviceType);
    try {
        const tenants = (await models.Tenant.findAll({
            attributes: ['id', 'name', 'username', 'role', 'is_key_personnel'],
            order: [['is_key_personnel', 'DESC'], ['id', 'ASC']],
            raw: true
        })).filter(t => isStatsTenantIncluded(t));

        const usageRows = await TenantDailyUsage.findAll({
            attributes: [
                'tenant_id',
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens']
            ],
            where: await buildStatsUsageWhere(service),
            group: ['tenant_id'],
            raw: true
        });
        const usageMap = new Map(usageRows.map((row) => [
            Number(row.tenant_id),
            {
                apiCalls: parseInt(row.apiCalls, 10) || 0,
                totalTokens: (parseInt(row.inputTokens, 10) || 0) + (parseInt(row.outputTokens, 10) || 0)
            }
        ]));

        return tenants.map((t) => ({
            tenantId: 'tenant_' + t.id,
            name: t.name,
            username: t.username,
            isKeyPersonnel: !!t.is_key_personnel,
            apiCalls: usageMap.get(Number(t.id))?.apiCalls || 0,
            totalTokens: usageMap.get(Number(t.id))?.totalTokens || 0
        })).sort((a, b) => Number(b.isKeyPersonnel) - Number(a.isKeyPersonnel) || b.totalTokens - a.totalTokens);
    } catch (error) {
        logger.error('查询重点人员失败:', error.message);
        return [];
    }
}

/**
 * 切换用户的重点人员标记
 * @param {{username: string, isKeyPersonnel: boolean}} body
 */
async function toggleKeyPersonnel(body) {
    const {username, isKeyPersonnel} = body;
    if (!username) throw new Error('缺少 username 参数');

    // 更新数据库
    await models.Tenant.update({is_key_personnel: !!isKeyPersonnel}, {where: {username}});

    // 同步更新内存缓存
    const key = !!isKeyPersonnel;
    syncKeyPersonnelCache(username, key);

    // 同步 relay  tenantManager
    try {
        const {tenantManager: relayManager} = await import('../services/relay/tenant-manager.js');

        for (const manager of [relayManager]) {
            if (manager?.tenantsCache) {
                for (const [, tenant] of manager.tenantsCache) {
                    if (tenant.username === username) {
                        tenant.is_key_personnel = key;
                        break;
                    }
                }
            }
            if (manager?.registry?.tenants) {
                for (const [, tenant] of Object.entries(manager.registry.tenants)) {
                    if (tenant.username === username) {
                        tenant.is_key_personnel = key;
                        break;
                    }
                }
            }
        }
    } catch {
        // 静默失败，重启后自动从DB加载
    }

    logger.info(`Key personnel ${username} ${key ? 'marked' : 'unmarked'}`);
}

/**
 * 获取用户的AI评估报告
 * @param {string} username
 */
async function getCoachAssessment(username, serviceType = 'codebuddy') {
    const service = normalizeStatsService(serviceType);
    // 查找租户
    const tenant = await models.Tenant.findOne({
        where: {username},
        attributes: ['id', 'is_key_personnel'],
        raw: true
    });

    if (!tenant) {
        return {username, hasAssessment: false};
    }

    const assessment = await models.AiAssessment.findOne({
        where: {tenant_id: tenant.id},
        order: [['created_at', 'DESC']],
        raw: true
    });

    const currentPeriod = getCurrentPeriod();
    const currentSampleCount = Math.max(
        await getSampleCount(tenant.id, currentPeriod),
        await models.ApiSample.count({
            where: {
                tenant_id: tenant.id,
                service_type: service,
                created_at: {gte: currentPeriod + '-01', lte: currentPeriod + '-31'}
            }
        })
    );

    if (!assessment) {
        return {
            username,
            hasAssessment: false,
            isKeyPersonnel: !!tenant.is_key_personnel,
            sampleCount: currentSampleCount
        };
    }

    // 实际可查看的样本数（文件+数据库元数据）
    const actualSampleCount = Math.max(
        await getSampleCount(tenant.id, assessment.period),
        await models.ApiSample.count({
            where: {
                tenant_id: tenant.id,
                service_type: service,
                created_at: {gte: assessment.period + '-01', lte: assessment.period + '-31'}
            }
        })
    );

    return {
        username,
        hasAssessment: true,
        isKeyPersonnel: true,
        assessment: {
            period: assessment.period,
            sampleCount: actualSampleCount,
            overallScore: assessment.overall_score,
            summary: assessment.summary,
            strengths: tryParseJson(assessment.strengths),
            improvements: tryParseJson(assessment.improvements),
            recommendations: tryParseJson(assessment.recommendations),
            skillScores: tryParseJson(assessment.skill_scores),
            status: assessment.status,
            triggeredBy: assessment.triggered_by,
            createdAt: assessment.created_at
        }
    };
}

/**
 * 手动触发AI分析
 * @param {string} [username] - 不传则分析所有重点人员
 */
async function triggerCoachAnalysis(username, serviceType = 'codebuddy') {
    const service = normalizeStatsService(serviceType);
    const period = getCurrentPeriod();

    if (username) {
        // 单用户分析
        const tenant = await models.Tenant.findOne({
            where: {username},
            attributes: ['id'],
            raw: true
        });

        if (!tenant) {
            throw new Error(`未找到用户: ${username}`);
        }

        const tenantKey = 'tenant_' + tenant.id;
        const result = await runAnalysis(tenantKey, period, 'manual');

        return {
            type: 'single',
            username,
            period,
            service,
            completed: result ? 1 : 0,
            failed: result ? 0 : 1,
            message: result ? '分析完成' : '分析失败（采样数据不足或执行异常）'
        };
    }

    // 全量分析
    const result = await runBatchAnalysis(period, 'manual');
    return {
        type: 'batch',
        period,
        service,
        ...result,
        message: `已完成 ${result.completed} 个，失败 ${result.failed} 个`
    };
}

/**
 * 获取当前月份（YYYY-MM）
 */
function getCurrentPeriod() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 安全解析JSON字符串
 */
function tryParseJson(str) {
    if (!str) return null;
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

/**
 * 获取指定日期的新增用户和日活用户列表
 * @param {string} date - 日期字符串，如 2025-01-15
 */
async function getDailyUserLists(serviceType = 'codebuddy', date, tenantId) {
    if (!unifiedTenantManager.isEnabled()) {
        return {newUsers: [], activeUsers: []};
    }
    const service = normalizeStatsService(serviceType);

    const tenants = (await getStatsTenantEntries())
        .filter(([, tenant]) => isStatsTenantVisibleInScope(tenant, tenantId));

    // 新增用户：created_at 对应的日期等于目标日期
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

    // 日活用户：从数据库查询当天有 api_calls > 0 的用户
    const activeUsers = [];
    try {
        const activeRows = await TenantDailyUsage.findAll({
            attributes: ['tenant_id', [fn('SUM', col('api_calls')), 'totalCalls']],
            where: await buildStatsUsageWhere(service, undefined, undefined, {date, api_calls: {[Op.gt]: 0}, ...(tenantId ? {tenant_id: tenantId} : {})}),
            group: ['tenant_id'],
            raw: true
        });

        // 构建tenant_id到tenant信息的映射
        const tenantMap = {};
        for (const [, t] of tenants) {
            tenantMap[t.id] = t;
        }

        // 批量查询日活用户的所有活跃日期，用于前端计算连续活跃天数
        const activeTenantIds = activeRows.map((r) => r.tenant_id);
        const activeDatesMap = {};
        if (activeTenantIds.length > 0) {
            try {
                const streakRows = await TenantDailyUsage.findAll({
                    attributes: ['tenant_id', 'date', [fn('SUM', col('api_calls')), 'totalCalls']],
                    where: await buildStatsUsageWhere(service, undefined, undefined, {tenant_id: {[Op.in]: activeTenantIds}}),
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

    // 日活用户按 apiCalls 降序排列
    activeUsers.sort((a, b) => b.apiCalls - a.apiCalls);

    return {newUsers, activeUsers};
}

/**
 * 获取用户每日使用详情
 * @param {string} username - 用户名
 */
async function getUserDetail(serviceType = 'codebuddy', username) {
    if (!unifiedTenantManager.isEnabled()) {
        return {
            username,
            totalApiCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            dailyData: {}
        };
    }
    const service = normalizeStatsService(serviceType);

    // 查找用户的租户
    let tenantId = null;
    let tenantData = null;

    for (const [, tenant] of await getStatsTenantEntries()) {
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

    // 从数据库读取每日使用数据
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
                    credit: 0
                };
            }
            dailyData[month][day].api_calls += row.api_calls || 0;
            dailyData[month][day].input_tokens += row.input_tokens || 0;
            dailyData[month][day].output_tokens += row.output_tokens || 0;
            dailyData[month][day].cache_hit_tokens += row.input_cache_hit || 0;
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

/**
 * 主路由处理函数
 */
export async function routeStatsRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API请求
    if (pathname.startsWith('/stats/api/')) {
        return await handleApiRequest(req, res);
    }

    // 静态资源
    // 统计页面
    return false;
}
