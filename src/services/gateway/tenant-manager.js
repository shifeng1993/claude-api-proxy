/**
 * 统一租户管理器
 * 不区分 service_type — 一个租户一条记录，通过 TenantServiceProfile 管理各服务
 * @module services/gateway/tenant-manager
 */

import {createHash, randomBytes} from 'crypto';
import {models} from '../../db/models/index.js';
import {TenantServiceProfile} from '../../db/models/tenant-service-profile.js';
import {UpstreamManager} from '../providers/index.js';
import {initDb} from '../../db/index.js';
import logger from '../../utils/logger.js';

const API_KEY_PREFIX = 'sk-';

class UnifiedTenantManager {
    constructor() {
        this._initialized = false;
        /** @type {Map<number, Object>} tenantId → tenant data from DB */
        this.tenantsCache = new Map();
        /** @type {Map<string, number>} apiKeyHash → tenantId */
        this.apiKeyHashMap = new Map();
        /** @type {Map<string, number>} username → tenantId */
        this.usernameMap = new Map();
        /** @type {Map<number, UpstreamManager>} */
        this.upstreamManagerCache = new Map();

        // Delta tracking for periodic flush
        this._dirtyTenants = new Set();
        this._deltaTenants = new Map(); // tenantId → {api_calls, input_tokens, output_tokens, cache_hit_tokens}
        this._flushInterval = null;

    }

    async initialize() {
        await initDb();
        await this._loadFromDb();

        // Set up credential associations (models are loaded at this point)
        if (!models.Tenant.associations.serviceProfiles) {
            models.Tenant.hasMany(TenantServiceProfile, {foreignKey: 'tenant_id', as: 'serviceProfiles', onDelete: 'CASCADE'});
            TenantServiceProfile.belongsTo(models.Tenant, {foreignKey: 'tenant_id', as: 'tenant'});
        }

        this._initialized = true;

        // Periodic flush every 30 seconds
        this._flushInterval = setInterval(() => this._flushDirtyTenants(), 30_000).unref();
    }

    async _loadFromDb() {
        const tenants = await models.Tenant.findAll({
            include: [{model: TenantServiceProfile, as: 'serviceProfiles'}]
        });

        this.tenantsCache.clear();
        this.apiKeyHashMap.clear();
        this.usernameMap.clear();

        for (const t of tenants) {
            const data = t.toJSON();
            this.tenantsCache.set(data.id, data);
            this.apiKeyHashMap.set(data.api_key_hash, data.id);
            if (data.username) {
                this.usernameMap.set(data.username, data.id);
            }
        }

        logger.info(`Unified tenant manager loaded ${tenants.length} tenants`);
    }

    isEnabled() {
        return this._initialized;
    }

    authenticate(apiKey) {
        if (!this._initialized) return null;
        const hash = createHash('sha256').update(apiKey).digest('hex');
        const tenantId = this.apiKeyHashMap.get(hash);
        return tenantId !== undefined ? tenantId : null;
    }

    getTenant(tenantId) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        return this.tenantsCache.get(id) || null;
    }

    findTenantByUsername(username) {
        return this.usernameMap.get(username) || null;
    }

    async getUpstreamManager(tenantId) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        if (!this.tenantsCache.has(id)) return null;

        if (this.upstreamManagerCache.has(id)) {
            const manager = this.upstreamManagerCache.get(id);
            await manager.reload();
            return manager;
        }

        const manager = new UpstreamManager({tenantId: id});
        await manager.init();
        this.upstreamManagerCache.set(id, manager);
        return manager;
    }

    listTenants() {
        return Array.from(this.tenantsCache.values()).map(t => ({
            id: t.id,
            name: t.name,
            username: t.username,
            api_key_prefix: t.api_key_prefix,
            role: t.role,
            serviceProfiles: (t.serviceProfiles || []).map(p => ({
                service_type: p.service_type,
                enabled: p.enabled,
                total_api_calls: p.total_api_calls,
                total_input_tokens: p.total_input_tokens,
                total_output_tokens: p.total_output_tokens,
                total_cache_hit_tokens: p.total_cache_hit_tokens,
                total_credit: p.total_credit
            }))
        }));
    }

    isAdmin(username) {
        for (const tenant of this.tenantsCache.values()) {
            if (tenant.username === username && ['admin', 'superadmin'].includes(tenant.role)) {
                return true;
            }
        }
        return false;
    }

    checkTenantAccess(username, tenantId) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const tenant = this.tenantsCache.get(id);
        return !!tenant && (tenant.username === username || this.isAdmin(username));
    }

    async setServiceEnabled(tenantId, serviceType, enabled) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        if (!this.tenantsCache.has(id)) return false;
        const [profile] = await TenantServiceProfile.findOrCreate({
            where: {tenant_id: id, service_type: serviceType},
            defaults: {tenant_id: id, service_type: serviceType, enabled: !!enabled}
        });
        if (profile.enabled !== !!enabled) {
            await profile.update({enabled: !!enabled});
        }
        await this._loadFromDb();
        return true;
    }

    async regenerateApiKey(tenantId) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const tenant = this.tenantsCache.get(id);
        if (!tenant) return null;

        const apiKey = API_KEY_PREFIX + randomBytes(16).toString('hex');
        const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
        const body = apiKey.slice(API_KEY_PREFIX.length);
        const apiKeyPrefix = API_KEY_PREFIX + body.slice(0, 8) + '****' + body.slice(-4);

        await models.Tenant.update({
            api_key_hash: apiKeyHash,
            api_key_prefix: apiKeyPrefix,
            api_key_plain: apiKey
        }, {where: {id}});
        await this._loadFromDb();
        return {apiKey, apiKeyPrefix};
    }

    /* ==================== Stats tracking ==================== */

    incrementApiCallCount(tenantId, serviceType) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const key = this._usageKey(id, serviceType);
        this._dirtyTenants.add(key);
        const delta = this._ensureDelta(id, serviceType);
        delta.api_calls++;
    }

    incrementTokenUsage(tenantId, serviceType, inputTokens, outputTokens, cacheHitTokens = 0) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const key = this._usageKey(id, serviceType);
        this._dirtyTenants.add(key);
        const delta = this._ensureDelta(id, serviceType);
        delta.input_tokens += inputTokens || 0;
        delta.output_tokens += outputTokens || 0;
        delta.cache_hit_tokens += cacheHitTokens || 0;
    }

    async recordDailyUsage(tenantId, serviceType, inputTokens, outputTokens, cacheHitTokens = 0, credit = 0, model = 'unknown') {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        try {
            const today = new Date().toISOString().slice(0, 10);
            const [record] = await models.TenantDailyUsage.findOrCreate({
                where: {tenant_id: id, service_type: serviceType, date: today, model: model || 'unknown'},
                defaults: {
                    tenant_id: id, service_type: serviceType, date: today, model: model || 'unknown',
                    api_calls: 0, input_tokens: 0, output_tokens: 0,
                    input_cache_hit: 0, input_cache_miss: 0, credit: 0
                }
            });
            const effectiveInput = inputTokens || 0;
            const effectiveHit = cacheHitTokens || 0;
            const cacheMiss = Math.max(0, effectiveInput - effectiveHit);
            await record.increment({
                api_calls: 1,
                input_tokens: effectiveInput,
                output_tokens: outputTokens || 0,
                input_cache_hit: effectiveHit,
                input_cache_miss: cacheMiss,
                credit: credit || 0
            });
            const cacheHitRate = effectiveInput > 0 ? (effectiveHit / effectiveInput) : 0;
            logger.info(`cache usage: tenant=${id} service=${serviceType} model=${model || 'unknown'} input=${effectiveInput} output=${outputTokens || 0} cacheHit=${effectiveHit} cacheHitRate=${cacheHitRate.toFixed(4)}`);
        } catch (error) {
            logger.error(`Failed to record daily usage for tenant ${id}: ${error.message}`);
        }
    }

    /**
     * 累加租户的积分消耗（内存中累计 + 增量追踪）
     * 供各服务路由记录服务维度 credit 消耗
     * @param {string|number} tenantId
     * @param {number} credit
     */
    incrementCreditUsage(tenantId, serviceType, credit = 0) {
        if (!credit) return;
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        const key = this._usageKey(id, serviceType);
        this._dirtyTenants.add(key);
        const delta = this._ensureDelta(id, serviceType);
        delta.credit = (delta.credit || 0) + credit;
    }

    /**
     * 确保租户的增量追踪条目存在
     */
    _usageKey(tenantId, serviceType) {
        if (!['relay', 'codebuddy'].includes(serviceType)) {
            throw new Error(`Unsupported service type: ${serviceType}`);
        }
        return `${tenantId}:${serviceType}`;
    }

    _ensureDelta(tenantId, serviceType) {
        const key = this._usageKey(tenantId, serviceType);
        if (!this._deltaTenants.has(key)) {
            this._deltaTenants.set(key, {
                api_calls: 0, input_tokens: 0, output_tokens: 0,
                cache_hit_tokens: 0, credit: 0
            });
        }
        return this._deltaTenants.get(key);
    }

    invalidateUpstreamCache(tenantId) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        this.upstreamManagerCache.delete(id);
    }

    async syncStatsFromDb(tenantId, reset = false) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        await this._flushDirtyTenants();
        if (reset && Number.isFinite(id)) {
            await TenantServiceProfile.update({
                total_api_calls: 0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_cache_hit_tokens: 0,
                total_credit: 0
            }, {where: {tenant_id: id}});
        }
        await this._loadFromDb();
    }

    async resetServiceStats(tenantId, serviceType) {
        const id = typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
        await this._flushDirtyTenants();
        await TenantServiceProfile.update({
            total_api_calls: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_hit_tokens: 0,
            total_credit: 0
        }, {where: {tenant_id: id, service_type: serviceType}});
        await this._loadFromDb();
    }

    async _flushDirtyTenants() {
        if (this._dirtyTenants.size === 0) return;
        const keys = [...this._dirtyTenants];
        this._dirtyTenants.clear();

        for (const key of keys) {
            const separator = key.lastIndexOf(':');
            const id = Number(key.slice(0, separator));
            const serviceType = key.slice(separator + 1);
            const delta = this._deltaTenants.get(key);
            if (!delta) continue;
            const d = {
                total_api_calls: delta.api_calls || 0,
                total_input_tokens: delta.input_tokens || 0,
                total_output_tokens: delta.output_tokens || 0,
                total_cache_hit_tokens: delta.cache_hit_tokens || 0,
                total_credit: delta.credit || 0
            };
            delta.api_calls = 0;
            delta.input_tokens = 0;
            delta.output_tokens = 0;
            delta.cache_hit_tokens = 0;
            delta.credit = 0;
            if (d.total_api_calls === 0 && d.total_input_tokens === 0 &&
                d.total_output_tokens === 0 && d.total_cache_hit_tokens === 0 &&
                d.total_credit === 0) continue;

            try {
                await TenantServiceProfile.increment(d, {
                    where: {tenant_id: id, service_type: serviceType}
                });
            } catch (error) {
                logger.error(`Failed to flush tenant ${id}/${serviceType}: ${error.message}`);
            }
        }
    }

    async flushApiCallCounts() {
        if (this._flushInterval) clearInterval(this._flushInterval);
        await this._flushDirtyTenants();
    }

    /* ==================== Tenant creation ==================== */

    async createTenantForUser(username, displayName) {
        const existing = this.usernameMap.get(username);
        if (existing) return existing;

        const role = username && username === process.env.LOCAL_ADMIN_USER ? 'superadmin' : 'user';
        const apiKey = API_KEY_PREFIX + randomBytes(16).toString('hex');
        const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
        const body = apiKey.slice(API_KEY_PREFIX.length);
        const apiKeyPrefix = API_KEY_PREFIX + body.slice(0, 8) + '****' + body.slice(-4);

        const tenant = await models.Tenant.create({
            name: displayName || username,
            username,
            api_key_hash: apiKeyHash,
            api_key_prefix: apiKeyPrefix,
            api_key_plain: apiKey,
            role
        });

        // Create service profiles for relay and codebuddy (enabled by default)
        await TenantServiceProfile.bulkCreate([
            {tenant_id: tenant.id, service_type: 'relay', enabled: true},
            {tenant_id: tenant.id, service_type: 'codebuddy', enabled: true}
        ]);

        // Reload cache
        await this._loadFromDb();
        return tenant.id;
    }

    async reloadRegistry() {
        await this._flushDirtyTenants();
        await this._loadFromDb();
    }

    async shutdown() {
        await this.flushApiCallCounts();
    }
}

export const unifiedTenantManager = new UnifiedTenantManager();
