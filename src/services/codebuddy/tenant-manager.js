/**
 * 租户管理器
 * 管理租户注册表、API Key 鉴权、TenantTokenManager 实例缓存
 * 数据持久化完全通过 Sequelize ORM 操作数据库
 * @module services/codebuddy/tenant-manager
 */

import {createHash, randomBytes} from 'crypto';
import logger from '../../utils/logger.js';
import {TenantTokenManager} from './tenant-token-manager.js';
import {models} from '../../db/models/index.js';
import {initDb} from '../../db/index.js';
import {Op} from 'sequelize';

const API_KEY_PREFIX = 'sk-codebuddy-';

class TenantManager {
    constructor() {
        /** @type {Object<string, Object>} 内存缓存，key 为 'tenant_' + tenant.id */
        this.registry = {tenants: {}};

        /** @type {Map<string, TenantTokenManager>} */
        this.tokenManagerCache = new Map();

        /** @type {Set<string>} 需要刷盘的租户 key 集合 */
        this._dirtyTenants = new Set();

        /** @type {Map<string, Object>} 自上次 flush 以来的统计增量，用于 INCREMENT 刷盘 */
        this._deltaTenants = new Map();

        /** @type {boolean} 数据库是否已初始化 */
        this._initialized = false;

        /** @type {Map<string, Promise>} 用户创建锁，防止并发创建重复租户 */
        this._createLocks = new Map();
    }

    /**
     * 初始化：连接数据库并加载租户数据到内存
     */
    async initialize() {
        await initDb();
        await this._loadFromDb();
        this._initialized = true;
        logger.info(`Codebuddy: Initialized tenant manager with ${Object.keys(this.registry.tenants).length} tenants from DB`);

        // 每 30 秒将脏统计数据刷盘，防止异常退出时丢失
        setInterval(() => this._flushDirtyTenants(), 30_000).unref();
    }

    /**
     * 从数据库加载所有 codebuddy 租户到内存
     */
    async _loadFromDb() {
        const tenants = await models.Tenant.findAll({
            where: {service_type: 'codebuddy'},
            include: [
                {model: models.TenantCredential, as: 'credentials'},
                {model: models.TenantState, as: 'state'}
            ]
        });

        this.registry.tenants = {};
        this._deltaTenants.clear();
        for (const tenant of tenants) {
            const key = 'tenant_' + tenant.id;
            this.registry.tenants[key] = this._mapTenantToMemory(tenant);
        }

        this.tokenManagerCache.clear();
    }

    /**
     * 将 DB Tenant 记录映射为内存对象
     * @param {Object} tenant - Sequelize Tenant 实例
     * @returns {Object}
     */
    _mapTenantToMemory(tenant) {
        return {
            id: tenant.id,
            name: tenant.name,
            api_key_hash: tenant.api_key_hash,
            api_key_prefix: tenant.api_key_prefix,
            api_key_plain: tenant.api_key_plain,
            username: tenant.username,
            role: tenant.role || 'user',
            created_at: tenant.created_at ? Math.floor(new Date(tenant.created_at).getTime() / 1000) : 0,
            credential_count: tenant.credentials ? tenant.credentials.length : 0,
            total_api_calls: tenant.total_api_calls || 0,
            total_input_tokens: tenant.total_input_tokens || 0,
            total_output_tokens: tenant.total_output_tokens || 0,
            total_cache_hit_tokens: tenant.total_cache_hit_tokens || 0,
            total_credit: tenant.total_credit || 0,
            state: tenant.state ? {
                current_index: tenant.state.current_index,
                disabled_indexes: tenant.state.disabled_indexes,
                active_upstream_index: tenant.state.active_upstream_index,
                saved_at: tenant.state.saved_at
            } : null
        };
    }

    /**
     * 将内存中的增量数据通过 INCREMENT 方式批量写回数据库
     * 使用 sequelize.increment 执行 SQL "SET col = col + N"，多进程安全
     */
    async _flushDirtyTenants() {
        if (this._dirtyTenants.size === 0) return;
        const ids = [...this._dirtyTenants];
        this._dirtyTenants.clear();
        for (const tenantKey of ids) {
            const tenant = this.registry.tenants[tenantKey];
            const delta = this._deltaTenants.get(tenantKey);
            if (!tenant || !delta) continue;
            // 取出增量并归零，确保不会重复累加
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
            // 无增量跳过
            if (d.total_api_calls === 0 && d.total_input_tokens === 0 &&
                d.total_output_tokens === 0 && d.total_cache_hit_tokens === 0 &&
                d.total_credit === 0) continue;
            try {
                await models.Tenant.increment(d, {where: {id: tenant.id}});
            } catch (error) {
                logger.error(`Failed to flush tenant ${tenantKey}: ${error.message}`);
            }
        }
    }

    /**
     * 同步所有租户的凭证数量到内存
     */
    _syncCredentialCounts() {
        for (const [tenantId, tenant] of Object.entries(this.registry.tenants)) {
            tenant.credential_count = this._getCredentialCount(tenantId);
        }
    }

    /**
     * 同步单个租户的凭证数量到内存
     * @param {string} tenantId
     */
    syncCredentialCount(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return;
        tenant.credential_count = this._getCredentialCount(tenantId);
    }

    /**
     * 获取租户的凭证数量
     * @param {string} tenantId
     * @returns {number}
     */
    _getCredentialCount(tenantId) {
        const manager = this.tokenManagerCache.get(tenantId);
        return manager ? manager.getCredentialsInfo().length : 0;
    }

    /**
     * 获取或初始化租户的增量追踪对象
     * @param {string} tenantId
     * @returns {Object}
     */
    _ensureDelta(tenantId) {
        if (!this._deltaTenants.has(tenantId)) {
            this._deltaTenants.set(tenantId, {
                api_calls: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_hit_tokens: 0,
                credit: 0
            });
        }
        return this._deltaTenants.get(tenantId);
    }

    /**
     * 递增租户的 /v1/messages 调用计数（内存中累计 + 增量追踪，定期 INCREMENT 刷盘）
     * @param {string} tenantId
     */
    incrementApiCallCount(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return;
        tenant.total_api_calls = (tenant.total_api_calls || 0) + 1;
        const delta = this._ensureDelta(tenantId);
        delta.api_calls++;
        this._dirtyTenants.add(tenantId);
    }

    /**
     * 累加租户的 token 使用量（内存中累计 + 增量追踪，定期 INCREMENT 刷盘）
     * @param {string} tenantId
     * @param {number} inputTokens
     * @param {number} outputTokens
     * @param {number} [cacheHitTokens=0]
     */
    incrementTokenUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return;
        inputTokens = inputTokens || 0;
        outputTokens = outputTokens || 0;
        cacheHitTokens = cacheHitTokens || 0;
        tenant.total_input_tokens = (tenant.total_input_tokens || 0) + inputTokens;
        tenant.total_output_tokens = (tenant.total_output_tokens || 0) + outputTokens;
        tenant.total_cache_hit_tokens = (tenant.total_cache_hit_tokens || 0) + cacheHitTokens;
        const delta = this._ensureDelta(tenantId);
        delta.input_tokens += inputTokens;
        delta.output_tokens += outputTokens;
        delta.cache_hit_tokens += cacheHitTokens;
        this._dirtyTenants.add(tenantId);
    }

    /**
     * 累加租户的积分消耗（内存中累计 + 增量追踪）
     * @param {string} tenantId
     * @param {number} credit
     */
    incrementCreditUsage(tenantId, credit = 0) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant || !credit) return;
        tenant.total_credit = (tenant.total_credit || 0) + credit;
        const delta = this._ensureDelta(tenantId);
        delta.credit += credit;
        this._dirtyTenants.add(tenantId);
    }

    /**
     * 重置租户的自定义统计数据（清零内存 + 增量 + 立即写 DB 0 + 广播通知其他进程）
     * 多进程安全：先清除增量，再清零 DB，最后广播让各进程从 DB 读取零值
     * @param {string} tenantId
     */
    async resetCustomStats(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return;

        // 先 flush 本进程该租户的脏数据，确保已产生的统计不丢失
        const delta = this._deltaTenants.get(tenantId);
        if (delta) {
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
            const hasDelta = d.total_api_calls || d.total_input_tokens || d.total_output_tokens || d.total_cache_hit_tokens || d.total_credit;
            if (hasDelta) {
                try {
                    await models.Tenant.increment(d, {where: {id: tenant.id}});
                } catch (error) {
                    logger.error(`Codebuddy: Failed to flush before reset for tenant ${tenantId}: ${error.message}`);
                }
            }
        }
        this._deltaTenants.delete(tenantId);
        this._dirtyTenants.delete(tenantId);

        // 立即将 DB 置零
        await models.Tenant.update(
            {
                total_api_calls: 0,
                total_input_tokens: 0,
                total_output_tokens: 0,
                total_cache_hit_tokens: 0,
                total_credit: 0
            },
            {where: {id: tenant.id}}
        );

        // 更新本进程内存
        tenant.total_api_calls = 0;
        tenant.total_input_tokens = 0;
        tenant.total_output_tokens = 0;
        tenant.total_cache_hit_tokens = 0;
        tenant.total_credit = 0;

        // 广播通知其他进程：先 flush 再从 DB 读取零值
        const {broadcast} = await import('../shared/cluster-broadcaster.js');
        broadcast('codebuddy:stats:reset', {tenantId});
    }

    /**
     * 将未刷盘的统计强制写入数据库（进程退出前调用）
     */
    async flushApiCallCounts() {
        await this._flushDirtyTenants();
    }

    /**
     * 记录每日使用数据（每次API请求完成时调用）
     * @param {string} tenantId
     * @param {number} inputTokens
     * @param {number} outputTokens
     * @param {number} [cacheHitTokens=0]
     * @param {number} [credit=0]
     * @param {string} [model='unknown']
     */
    async recordDailyUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0, credit = 0, model = 'unknown') {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return;

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        try {
            // 清理3个月前的旧数据
            const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1);
            const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
            await models.TenantDailyUsage.destroy({
                where: {
                    tenant_id: tenant.id,
                    date: {[Op.lt]: cutoffStr}
                }
            });

            const [usage] = await models.TenantDailyUsage.findOrCreate({
                where: {
                    tenant_id: tenant.id,
                    service_type: 'codebuddy',
                    model: model,
                    date: dateStr
                },
                defaults: {
                    api_calls: 0,
                    input_tokens: 0,
                    input_cache_hit: 0,
                    input_cache_miss: 0,
                    output_tokens: 0,
                    credit: 0
                }
            });

            await usage.increment({
                api_calls: 1,
                input_tokens: inputTokens || 0,
                output_tokens: outputTokens || 0,
                input_cache_hit: cacheHitTokens || 0,
                credit: credit || 0
            });
        } catch (error) {
            logger.error(`Failed to record daily usage for ${tenantId}: ${error.message}`);
        }
    }

    /**
     * 获取指定月份的每日使用数据
     * @param {string} tenantId
     * @param {string} monthKey - 格式 "YYYY-MM"
     * @returns {Object|null}
     */
    async getDailyUsage(tenantId, monthKey) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return null;

        try {
            const records = await models.TenantDailyUsage.findAll({
                where: {
                    tenant_id: tenant.id,
                    service_type: 'codebuddy',
                    date: {[Op.like]: monthKey + '-%'}
                }
            });

            if (records.length === 0) return null;

            // 按日期聚合（同一天可能有多个 model 的记录）
            const result = {};
            for (const record of records) {
                const day = record.date.slice(8); // 取 "DD" 部分
                if (!result[day]) {
                    result[day] = {api_calls: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, credit: 0};
                }
                result[day].api_calls += record.api_calls || 0;
                result[day].input_tokens += record.input_tokens || 0;
                result[day].output_tokens += record.output_tokens || 0;
                result[day].cache_hit_tokens += record.input_cache_hit || 0;
                result[day].credit += record.credit || 0;
            }
            return result;
        } catch (error) {
            logger.error(`Failed to get daily usage for ${tenantId}: ${error.message}`);
            return null;
        }
    }

    /**
     * 获取按模型维度的每日使用数据
     * @param {string} tenantId
     * @param {string} monthKey - 格式 "YYYY-MM"
     */
    async getModelDailyUsage(tenantId, monthKey) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return null;

        try {
            const records = await models.TenantDailyUsage.findAll({
                where: {
                    tenant_id: tenant.id,
                    service_type: 'codebuddy',
                    date: {[Op.like]: monthKey + '-%'}
                },
                order: [['model', 'ASC'], ['date', 'ASC']]
            });

            if (records.length === 0) return null;

            const modelSet = new Set();
            const data = {};
            const summary = {};

            for (const record of records) {
                const model = record.model || 'unknown';
                const day = record.date.slice(8);

                modelSet.add(model);

                if (!data[model]) data[model] = {};
                data[model][day] = {
                    api_calls: record.api_calls || 0,
                    input_tokens: record.input_tokens || 0,
                    output_tokens: record.output_tokens || 0,
                    cache_hit_tokens: record.input_cache_hit || 0,
                    credit: record.credit || 0
                };

                if (!summary[model]) {
                    summary[model] = {api_calls: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, credit: 0};
                }
                summary[model].api_calls += record.api_calls || 0;
                summary[model].input_tokens += record.input_tokens || 0;
                summary[model].output_tokens += record.output_tokens || 0;
                summary[model].cache_hit_tokens += record.input_cache_hit || 0;
                summary[model].credit += record.credit || 0;
            }

            for (const model of Object.keys(summary)) {
                const s = summary[model];
                s.cache_hit_rate = s.input_tokens > 0
                    ? Math.round((s.cache_hit_tokens / s.input_tokens) * 100)
                    : 0;
            }

            return {
                month: monthKey,
                models: Array.from(modelSet).sort(),
                data,
                summary
            };
        } catch (error) {
            logger.error(`Failed to get model daily usage for ${tenantId}: ${error.message}`);
            return null;
        }
    }

    /**
     * 获取可用月份列表（近3个月，降序）
     * @param {string} tenantId
     * @returns {string[]}
     */
    async getAvailableMonths(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) return [];

        try {
            const records = await models.TenantDailyUsage.findAll({
                where: {
                    tenant_id: tenant.id,
                    service_type: 'codebuddy'
                },
                attributes: ['date'],
                group: ['date'],
                raw: true
            });

            const monthSet = new Set();
            for (const record of records) {
                // date 格式为 "YYYY-MM-DD"，取前7位得到 "YYYY-MM"
                const month = record.date.slice(0, 7);
                monthSet.add(month);
            }

            return Array.from(monthSet).sort().reverse().slice(0, 3);
        } catch (error) {
            logger.error(`Failed to get available months for ${tenantId}: ${error.message}`);
            return [];
        }
    }

    /**
     * 生成 API Key：sk-codebuddy-<32位hex>
     * @returns {string}
     */
    _generateApiKey() {
        return API_KEY_PREFIX + randomBytes(16).toString('hex');
    }

    /**
     * 计算 API Key 的 SHA-256 哈希
     * @param {string} apiKey
     * @returns {string}
     */
    _hashApiKey(apiKey) {
        return createHash('sha256').update(apiKey).digest('hex');
    }

    /**
     * 生成 API Key 前缀显示：sk-codebuddy-前8位****后4位
     * @param {string} apiKey
     * @returns {string}
     */
    _getApiKeyPrefix(apiKey) {
        const body = apiKey.slice(API_KEY_PREFIX.length);
        return API_KEY_PREFIX + body.slice(0, 8) + '****' + body.slice(-4);
    }

    /**
     * 根据 API Key 查找租户（同步，从内存缓存查找）
     * @param {string} apiKey
     * @returns {string|null} tenant_id (如 'tenant_1') 或 null
     */
    authenticate(apiKey) {
        if (!this.isEnabled()) {
            return null;
        }

        const hash = this._hashApiKey(apiKey);
        for (const [tenantId, tenant] of Object.entries(this.registry.tenants)) {
            if (tenant.api_key_hash === hash) {
                return tenantId;
            }
        }

        logger.debug('Authentication failed: no matching API key hash');
        return null;
    }

    /**
     * 获取租户的 TenantTokenManager 实例（带缓存）
     * @param {string} tenantId - 内存 key，如 'tenant_1'
     * @returns {TenantTokenManager|null}
     */
    async getTenantManager(tenantId) {
        if (!this.registry.tenants[tenantId]) {
            logger.warn(`Tenant not found: ${tenantId}`);
            return null;
        }

        if (this.tokenManagerCache.has(tenantId)) {
            const manager = this.tokenManagerCache.get(tenantId);
            // 重新加载凭证列表和状态，确保多进程下数据一致
            await manager.loadAllTokens();
            await manager.loadState();
            return manager;
        }

        const tenant = this.registry.tenants[tenantId];

        const manager = await TenantTokenManager.create(null, {tenantId: tenant.id});
        this.tokenManagerCache.set(tenantId, manager);
        return manager;
    }

    /**
     * 创建租户
     * @param {string} name
     * @returns {Promise<{tenantId: string, apiKey: string, name: string}>}
     */
    async createTenant(name) {
        const apiKey = this._generateApiKey();

        const tenant = await models.Tenant.create({
            service_type: 'codebuddy',
            name,
            api_key_hash: this._hashApiKey(apiKey),
            api_key_prefix: this._getApiKeyPrefix(apiKey),
            api_key_plain: apiKey,
            total_api_calls: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_hit_tokens: 0,
            total_credit: 0
        });

        // 创建初始状态
        await models.TenantState.create({
            tenant_id: tenant.id,
            current_index: 0,
            disabled_indexes: []
        });

        const tenantId = 'tenant_' + tenant.id;

        // 写入内存缓存
        this.registry.tenants[tenantId] = {
            id: tenant.id,
            name,
            api_key_hash: this._hashApiKey(apiKey),
            api_key_prefix: this._getApiKeyPrefix(apiKey),
            api_key_plain: apiKey,
            username: null,
            created_at: Math.floor(Date.now() / 1000),
            credential_count: 0,
            total_api_calls: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_hit_tokens: 0,
            total_credit: 0,
            state: null
        };

        logger.info(`Created tenant: ${tenantId} (${name})`);
        return {tenantId, apiKey, name};
    }

    /**
     * 根据 LDAP 用户名查找租户
     * @param {string} username
     * @returns {Promise<string|null>} tenant_id 或 null
     */
    async findTenantByUsername(username) {
        // 先查内存
        for (const [tenantId, tenant] of Object.entries(this.registry.tenants)) {
            if (tenant.username === username) {
                return tenantId;
            }
        }

        // 内存未命中，查 DB
        try {
            const tenant = await models.Tenant.findOne({
                where: {service_type: 'codebuddy', username}
            });
            if (tenant) {
                const tenantId = 'tenant_' + tenant.id;
                // 如果内存中没有，加载到内存
                if (!this.registry.tenants[tenantId]) {
                    const fullTenant = await models.Tenant.findByPk(tenant.id, {
                        include: [
                            {model: models.TenantCredential, as: 'credentials'},
                            {model: models.TenantState, as: 'state'}
                        ]
                    });
                    if (fullTenant) {
                        this.registry.tenants[tenantId] = this._mapTenantToMemory(fullTenant);
                    }
                }
                return tenantId;
            }
        } catch (error) {
            logger.error(`Failed to find tenant by username: ${error.message}`);
        }

        return null;
    }

    /**
     * 为 LDAP 用户自动创建租户（首次登录时）
     * @param {string} username
     * @param {string} [displayName]
     * @returns {Promise<{tenantId: string, apiKey: string|null, name: string}>}
     */
    async createTenantForUser(username, displayName) {
        // 等待同一 username 的在途创建完成，防止并发竞态产生重复租户
        const pending = this._createLocks.get(username);
        if (pending) {
            await pending;
            // 在途创建完成后重新查找
            const existingId = await this.findTenantByUsername(username);
            if (existingId) {
                const tenant = this.registry.tenants[existingId];
                const effectiveName = displayName || username;
                if (effectiveName && tenant.name !== effectiveName) {
                    tenant.name = effectiveName;
                    await models.Tenant.update({name: effectiveName}, {where: {id: tenant.id}});
                }
                return {tenantId: existingId, apiKey: tenant.api_key_plain || null, name: tenant.name};
            }
        }

        const createPromise = this._doCreateTenantForUser(username, displayName);
        this._createLocks.set(username, createPromise);
        try {
            return await createPromise;
        } finally {
            this._createLocks.delete(username);
        }
    }

    async _doCreateTenantForUser(username, displayName) {
        const existingId = await this.findTenantByUsername(username);
        if (existingId) {
            const tenant = this.registry.tenants[existingId];
            const apiKey = tenant.api_key_plain || null;
            // 登录时同步更新 name（LDAP 中 displayName 可能变更，或首次创建时为空）
            const effectiveName = displayName || username;
            if (effectiveName && tenant.name !== effectiveName) {
                tenant.name = effectiveName;
                await models.Tenant.update({name: effectiveName}, {where: {id: tenant.id}});
                logger.info(`Updated tenant name for ${username}: ${effectiveName}`);
            }
            return {tenantId: existingId, apiKey, name: tenant.name};
        }

        const result = await this.createTenant(displayName || username);

        this.registry.tenants[result.tenantId].username = username;
        await models.Tenant.update({username}, {where: {id: this.registry.tenants[result.tenantId].id}});

        logger.info(`Auto-created tenant for LDAP user: ${username} -> ${result.tenantId}`);
        return result;
    }

    /**
     * 删除租户及所有凭证，清理缓存
     * @param {string} tenantId
     * @returns {Promise<boolean>}
     */
    async deleteTenant(tenantId) {
        if (!this.registry.tenants[tenantId]) {
            logger.warn(`Cannot delete: tenant not found: ${tenantId}`);
            return false;
        }

        const tenant = this.registry.tenants[tenantId];
        const dbId = tenant.id;

        // 清理缓存
        this.tokenManagerCache.delete(tenantId);
        this._dirtyTenants.delete(tenantId);
        this._deltaTenants.delete(tenantId);

        // 从数据库删除（CASCADE 会自动删关联数据）
        try {
            await models.Tenant.destroy({where: {id: dbId}});
        } catch (error) {
            logger.error(`Failed to delete tenant from DB: ${error.message}`);
        }

        // 从内存移除
        delete this.registry.tenants[tenantId];

        logger.info(`Deleted tenant: ${tenantId}`);
        return true;
    }

    /**
     * 重新生成 API Key
     * @param {string} tenantId
     * @returns {Promise<{apiKey: string}|null>}
     */
    async regenerateApiKey(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) {
            logger.warn(`Cannot regenerate API key: tenant not found: ${tenantId}`);
            return null;
        }

        const apiKey = this._generateApiKey();
        const newHash = this._hashApiKey(apiKey);
        const newPrefix = this._getApiKeyPrefix(apiKey);
        tenant.api_key_hash = newHash;
        tenant.api_key_prefix = newPrefix;
        tenant.api_key_plain = apiKey;

        await models.Tenant.update(
            {api_key_hash: newHash, api_key_prefix: newPrefix, api_key_plain: apiKey},
            {where: {id: tenant.id}}
        );
        logger.info(`Regenerated API key for tenant: ${tenantId}`);
        return {apiKey};
    }

    /**
     * 列出所有租户信息
     * @returns {Array<{tenantId: string, name: string, apiKeyPrefix: string, createdAt: number, credentialCount: number, validCredentialCount: number}>}
     */
    listTenants() {
        return Object.entries(this.registry.tenants).map(([tenantId, tenant]) => {
            const manager = this.tokenManagerCache.get(tenantId);
            let credentialCount = 0;
            let validCredentialCount = 0;

            if (manager) {
                const credsInfo = manager.getCredentialsInfo();
                credentialCount = credsInfo.length;
                validCredentialCount = credsInfo.filter((c) => !c.isExpired).length;
            }

            return {
                tenantId,
                name: tenant.name,
                role: tenant.role || 'user',
                apiKeyPrefix: tenant.api_key_prefix,
                createdAt: tenant.created_at,
                credentialCount,
                validCredentialCount,
                customApiCallCount: tenant.total_api_calls || 0,
                customInputTokens: tenant.total_input_tokens || 0,
                customOutputTokens: tenant.total_output_tokens || 0,
                customCacheHitTokens: tenant.total_cache_hit_tokens || 0,
                customCredit: tenant.total_credit || 0
            };
        });
    }

    /**
     * 从数据库重新加载注册表，并广播通知其他进程同步
     */
    async reloadRegistry() {
        await this._flushDirtyTenants();
        await this._loadFromDb();
        logger.info('Tenant registry reloaded from DB');

        // 广播通知其他进程同步
        const {broadcast} = await import('../shared/cluster-broadcaster.js');
        broadcast('codebuddy:stats:refresh', {});
    }

    /**
     * 获取单个租户详情
     * @param {string} tenantId
     * @returns {Object|null}
     */
    getTenant(tenantId) {
        const tenant = this.registry.tenants[tenantId];
        if (!tenant) {
            return null;
        }

        const manager = this.tokenManagerCache.get(tenantId);
        let credentialCount = 0;
        let validCredentialCount = 0;

        if (manager) {
            const credsInfo = manager.getCredentialsInfo();
            credentialCount = credsInfo.length;
            validCredentialCount = credsInfo.filter((c) => !c.isExpired).length;
        }

        return {
            tenantId,
            name: tenant.name,
            username: tenant.username,
            role: tenant.role || 'user',
            apiKeyPrefix: tenant.api_key_prefix,
            apiKeyPlain: tenant.api_key_plain || null,
            createdAt: tenant.created_at,
            credentialCount,
            validCredentialCount,
            customApiCallCount: tenant.total_api_calls || 0,
            customInputTokens: tenant.total_input_tokens || 0,
            customOutputTokens: tenant.total_output_tokens || 0,
            customCacheHitTokens: tenant.total_cache_hit_tokens || 0,
            customCredit: tenant.total_credit || 0
        };
    }

    /**
     * 返回租户系统是否已启用（数据库已初始化）
     * @returns {boolean}
     */
    isEnabled() {
        return this._initialized;
    }

    /**
     * 从数据库同步指定租户的统计数据到内存（收到广播通知后调用）
     * 先 flush 本进程的脏数据，再从 DB 读取最新值，确保多进程一致性
     * @param {string} [tenantId] - 租户 key（如 'tenant_1'），不传则同步所有租户
     * @param {boolean} [isReset=false] - 是否为重置操作，如果是则 flush 后再清零 DB（防止增量覆盖重置）
     */
    async syncStatsFromDb(tenantId, isReset = false) {
        // 先 flush 本进程该租户的脏数据，避免旧增量覆盖
        if (tenantId) {
            const delta = this._deltaTenants.get(tenantId);
            if (delta) {
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
                const hasDelta = d.total_api_calls || d.total_input_tokens || d.total_output_tokens || d.total_cache_hit_tokens || d.total_credit;
                if (hasDelta) {
                    const tenant = this.registry.tenants[tenantId];
                    if (tenant) {
                        try {
                            await models.Tenant.increment(d, {where: {id: tenant.id}});
                        } catch (error) {
                            logger.error(`Codebuddy: Failed to flush before sync for tenant ${tenantId}: ${error.message}`);
                        }
                    }
                }
            }
            this._deltaTenants.delete(tenantId);
            this._dirtyTenants.delete(tenantId);
        } else {
            await this._flushDirtyTenants();
        }

        // 如果是重置操作，flush 完增量后再次确保 DB 为零值
        if (isReset) {
            if (tenantId) {
                const tenant = this.registry.tenants[tenantId];
                if (tenant) {
                    await models.Tenant.update(
                        {total_api_calls: 0, total_input_tokens: 0, total_output_tokens: 0, total_cache_hit_tokens: 0, total_credit: 0},
                        {where: {id: tenant.id}}
                    );
                }
            }
        }

        if (tenantId) {
            const tenant = this.registry.tenants[tenantId];
            if (!tenant) return;
            // 从 DB 读取最新统计值
            const dbTenant = await models.Tenant.findByPk(tenant.id);
            if (!dbTenant) return;
            tenant.total_api_calls = dbTenant.total_api_calls || 0;
            tenant.total_input_tokens = dbTenant.total_input_tokens || 0;
            tenant.total_output_tokens = dbTenant.total_output_tokens || 0;
            tenant.total_cache_hit_tokens = dbTenant.total_cache_hit_tokens || 0;
            tenant.total_credit = dbTenant.total_credit || 0;
            logger.info(`Codebuddy: Synced stats from DB for tenant ${tenantId} (isReset=${isReset})`);
        } else {
            // 同步所有租户
            await this._loadFromDb();
            logger.info('Codebuddy: Synced all tenant stats from DB');
        }
    }

    /**
     * 重新加载指定租户的凭证缓存（收到广播通知后调用）
     * 清除 tokenManagerCache 中该租户的缓存，下次请求时重新从 DB 加载
     * @param {string} tenantId - 租户 key（如 'tenant_1'）
     */
    async reloadCredentialCache(tenantId) {
        // 清除缓存的 TenantTokenManager 实例，下次 getTenantManager 时会重新创建
        this.tokenManagerCache.delete(tenantId);

        // 如果内存中有该租户，同步其凭证数量
        const tenant = this.registry.tenants[tenantId];
        if (tenant) {
            // 从 DB 重新加载凭证数量
            const credentialCount = await models.TenantCredential.count({
                where: {tenant_id: tenant.id}
            });
            tenant.credential_count = credentialCount;

            // 从 DB 重新加载状态
            const state = await models.TenantState.findOne({
                where: {tenant_id: tenant.id}
            });
            if (state) {
                tenant.state = {
                    current_index: state.current_index,
                    disabled_indexes: state.disabled_indexes,
                    active_upstream_index: state.active_upstream_index,
                    saved_at: state.saved_at
                };
            }
        }

        logger.info(`Codebuddy: Reloaded credential cache for tenant ${tenantId}`);
    }
}

export const tenantManager = new TenantManager();

export {TenantManager};
