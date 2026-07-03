/**
 * 统计 API 路由
 * @module routes/stats
 */

import {
    createGatewayStatsUsageService,
    getSessionUser,
    unifiedTenantManager
} from '../services/gateway/index.js';
import logger from '../utils/logger.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

const STATS_SERVICE_TYPES = new Set(['relay', 'codebuddy']);
const EMPTY_STATS_TENANT_ID = -1;
const statsUsage = createGatewayStatsUsageService({tenantManager: unifiedTenantManager});

function normalizeStatsService(serviceType) {
    return STATS_SERVICE_TYPES.has(serviceType) ? serviceType : 'codebuddy';
}

function getStatsService(url) {
    return normalizeStatsService(url.searchParams.get('service') || 'codebuddy');
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
    const entry = (await statsUsage.getStatsTenantEntries()).find(([, tenant]) => tenant?.username === session.username);
    return entry?.[1]?.id || EMPTY_STATS_TENANT_ID;
}

async function handleOverview(req, res, url) {
    const service = getStatsService(url);
    const {startDate, endDate} = resolveDateRange(url);
    try {
        const tenantId = await getCurrentStatsTenantId(req);
        const stats = await statsUsage.getOverviewStats(service, startDate, endDate, tenantId);
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
            monthlyTrend: await statsUsage.getMonthlyTrendData(service, tenantId, startDate, endDate),
            userTrend: await statsUsage.getUserTrendData(service, tenantId)
        });
    } catch (error) {
        logger.error('获取统计数据失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

async function handleApiRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/stats/api/overview' && req.method === 'GET') {
        await handleOverview(req, res, url);
        return true;
    }

    if (pathname === '/stats/api/model-cache-stats' && req.method === 'GET') {
        const service = getStatsService(url);
        const {startDate, endDate} = resolveDateRange(url);
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await statsUsage.getModelCacheStats(service, startDate, endDate, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取模型缓存统计失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

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
            const data = await statsUsage.getModelCacheDailyTrend(service, model, startDate, endDate, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取模型每日缓存趋势失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    if (pathname === '/stats/api/daily-trend' && req.method === 'GET') {
        const service = getStatsService(url);
        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await statsUsage.getDailyTrendData(service, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取每日趋势数据失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    if (pathname === '/stats/api/daily-users' && req.method === 'GET') {
        const service = getStatsService(url);
        const date = url.searchParams.get('date');
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            sendJson(res, 400, {error: '缺少有效的 date 参数（格式：YYYY-MM-DD）'});
            return true;
        }

        try {
            const tenantId = await getCurrentStatsTenantId(req);
            const data = await statsUsage.getDailyUserLists(service, date, tenantId);
            sendJson(res, 200, data);
        } catch (error) {
            logger.error('获取每日用户列表失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

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
            const userDetail = await statsUsage.getUserDetail(service, username);
            sendJson(res, 200, userDetail);
        } catch (error) {
            logger.error('获取用户详情失败:', error);
            sendJson(res, 500, {error: error.message});
        }
        return true;
    }

    return false;
}

export async function routeStatsRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/stats/api/')) {
        return await handleApiRequest(req, res);
    }

    return false;
}
