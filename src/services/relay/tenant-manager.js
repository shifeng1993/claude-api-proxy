/**
 * Relay 租户管理器
 * 管理租户注册表、API Key 鉴权、UpstreamManager 实例缓存及使用量统计
 * 基于 Sequelize ORM，数据持久化到 SQLite
 * @module services/relay/tenant-manager
 */

import {createHash, randomBytes} from 'crypto';
import {Op} from 'sequelize';
import logger from '../../utils/logger.js';
import {models} from '../../db/models/index.js';
import {initDb} from '../../db/index.js';
import {UpstreamManager} from './upstream-manager.js';
import {API_KEY_PREFIX} from './config.js';

const SERVICE_TYPE = 'relay';

class TenantManager {
  constructor() {
    /** @type {Map<number, Object>} 内存缓存：tenant.id -> tenant 数据 */
    this.tenantsCache = new Map();
    /** @type {Map<string, number>} api_key_hash -> tenant.id，用于 authenticate 快速查找 */
    this.apiKeyHashMap = new Map();
    /** @type {Map<number, UpstreamManager>} */
    this.upstreamManagerCache = new Map();
    /** @type {Set<number>} 需要刷盘的租户 ID 集合 */
    this._dirtyTenants = new Set();
    /** @type {Map<number, Object>} 自上次 flush 以来的统计增量，用于 INCREMENT 刷盘 */
    this._deltaTenants = new Map();
    /** @type {boolean} 是否已初始化 */
    this._initialized = false;
    /** @type {Map<string, Promise>} 用户创建锁，防止并发创建重复租户 */
    this._createLocks = new Map();
  }

  /** 确保 tenantId 为数字类型（路由层传入的可能是字符串） */
  _id(tenantId) {
    return typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
  }

  /**
   * 初始化：连接数据库、同步表结构、加载 relay 租户到内存
   */
  async initialize() {
    if (this._initialized) return;
    await initDb();
    await this._loadFromDb();
    this._initialized = true;
    logger.info(`Relay: TenantManager initialized with ${this.tenantsCache.size} relay tenants`);

    // 每 30 秒将脏统计数据刷盘，防止异常退出时丢失
    setInterval(() => this._flushDirtyTenants(), 30_000).unref();
  }

  /**
   * 从数据库加载所有 relay 租户到内存
   */
  async _loadFromDb() {
    const tenants = await models.Tenant.findAll({
      where: {service_type: SERVICE_TYPE}
    });
    this.tenantsCache.clear();
    this.apiKeyHashMap.clear();
    this._deltaTenants.clear();
    for (const t of tenants) {
      const data = this._tenantToMemory(t);
      this.tenantsCache.set(t.id, data);
      this.apiKeyHashMap.set(t.api_key_hash, t.id);
    }
  }

  /**
   * 将 Sequelize 实例转为内存缓存对象
   */
  _tenantToMemory(t) {
    return {
      id: t.id,
      name: t.name,
      api_key_hash: t.api_key_hash,
      api_key_prefix: t.api_key_prefix,
      api_key_plain: t.api_key_plain,
      username: t.username,
      role: t.role || 'user',
      total_api_calls: t.total_api_calls || 0,
      total_input_tokens: t.total_input_tokens || 0,
      total_output_tokens: t.total_output_tokens || 0,
      total_cache_hit_tokens: t.total_cache_hit_tokens || 0,
      is_key_personnel: !!t.is_key_personnel,
      created_at: t.created_at
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
    for (const id of ids) {
      const data = this.tenantsCache.get(id);
      const delta = this._deltaTenants.get(id);
      if (!data || !delta) continue;
      // 取出增量并归零，确保不会重复累加
      const d = {
        total_api_calls: delta.api_calls || 0,
        total_input_tokens: delta.input_tokens || 0,
        total_output_tokens: delta.output_tokens || 0,
        total_cache_hit_tokens: delta.cache_hit_tokens || 0
      };
      delta.api_calls = 0;
      delta.input_tokens = 0;
      delta.output_tokens = 0;
      delta.cache_hit_tokens = 0;
      // 无增量跳过
      if (d.total_api_calls === 0 && d.total_input_tokens === 0 &&
          d.total_output_tokens === 0 && d.total_cache_hit_tokens === 0) continue;
      try {
        await models.Tenant.increment(d, {where: {id}});
      } catch (error) {
        logger.error(`Relay: Failed to flush tenant ${id}: ${error.message}`);
      }
    }
  }

  isEnabled() {
    return this._initialized;
  }

  _generateApiKey() {
    return API_KEY_PREFIX + randomBytes(16).toString('hex');
  }

  _hashApiKey(apiKey) {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  _getApiKeyPrefix(apiKey) {
    const body = apiKey.slice(API_KEY_PREFIX.length);
    return API_KEY_PREFIX + body.slice(0, 8) + '****' + body.slice(-4);
  }

  /**
   * 根据 API Key 鉴权，返回 tenant.id 或 null（同步查内存）
   * @param {string} apiKey
   * @returns {number|null}
   */
  authenticate(apiKey) {
    if (!this._initialized) return null;
    const hash = this._hashApiKey(apiKey);
    const tenantId = this.apiKeyHashMap.get(hash);
    return tenantId !== undefined ? tenantId : null;
  }

  /**
   * 获取租户的 UpstreamManager 实例（带缓存）
   * 缓存实例会在每次获取时重新加载上游配置，确保多进程/多实例场景下数据及时同步
   * @param {number} tenantId
   * @returns {Promise<UpstreamManager|null>}
   */
  async getUpstreamManager(tenantId) {
    tenantId = this._id(tenantId);
    if (!this.tenantsCache.has(tenantId)) return null;
    if (this.upstreamManagerCache.has(tenantId)) {
      const manager = this.upstreamManagerCache.get(tenantId);
      // 重新加载上游配置和活跃索引，确保数据最新
      await manager.reload();
      return manager;
    }
    const manager = new UpstreamManager({tenantId});
    await manager.init();
    this.upstreamManagerCache.set(tenantId, manager);
    return manager;
  }

  /**
   * 创建租户
   * @param {string} name
   * @returns {Promise<{tenantId: number, apiKey: string, name: string}>}
   */
  async createTenant(name) {
    const apiKey = this._generateApiKey();
    const tenant = await models.Tenant.create({
      service_type: SERVICE_TYPE,
      name,
      api_key_hash: this._hashApiKey(apiKey),
      api_key_prefix: this._getApiKeyPrefix(apiKey),
      api_key_plain: null,
      username: null,
      total_api_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_hit_tokens: 0,
      total_credit: 0
    });
    const data = this._tenantToMemory(tenant);
    this.tenantsCache.set(tenant.id, data);
    this.apiKeyHashMap.set(tenant.api_key_hash, tenant.id);
    logger.info(`Relay: Created tenant ${tenant.id} (${name})`);
    return {tenantId: tenant.id, apiKey, name};
  }

  /**
   * 为 LDAP 用户自动创建租户（首次登录时）
   * @param {string} username
   * @param {string} [displayName]
   * @returns {Promise<{tenantId: number, apiKey: string|null, name: string}>}
   */
  async createTenantForUser(username, displayName) {
    // 等待同一 username 的在途创建完成，防止并发竞态产生重复租户
    const pending = this._createLocks.get(username);
    if (pending) {
      await pending;
      const existingId = await this.findTenantByUsername(username);
      if (existingId) {
        const tenant = this.tenantsCache.get(existingId);
        const effectiveName = displayName || username;
        if (effectiveName && tenant.name !== effectiveName) {
          tenant.name = effectiveName;
          await models.Tenant.update({name: effectiveName}, {where: {id: existingId}});
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
      const tenant = this.tenantsCache.get(existingId);
      const apiKey = tenant.api_key_plain || null;
      // 登录时同步更新 name（LDAP 中 displayName 可能变更，或首次创建时为空）
      const effectiveName = displayName || username;
      if (effectiveName && tenant.name !== effectiveName) {
        tenant.name = effectiveName;
        await models.Tenant.update({name: effectiveName}, {where: {id: existingId}});
        logger.info(`Relay: Updated tenant name for ${username}: ${effectiveName}`);
      }
      return {tenantId: existingId, apiKey, name: tenant.name};
    }
    const result = await this.createTenant(displayName || username);
    const tenant = this.tenantsCache.get(result.tenantId);
    tenant.username = username;
    tenant.api_key_plain = result.apiKey;
    await models.Tenant.update(
      {username, api_key_plain: result.apiKey},
      {where: {id: result.tenantId}}
    );
    logger.info(`Relay: Auto-created tenant for LDAP user: ${username} -> ${result.tenantId}`);
    return result;
  }

  /**
   * 根据 LDAP 用户名查找租户
   * @param {string} username
   * @returns {Promise<number|null>} tenant.id 或 null
   */
  async findTenantByUsername(username) {
    // 优先查内存
    for (const [id, tenant] of this.tenantsCache) {
      if (tenant.username === username) return id;
    }
    // 内存未命中，查数据库
    const tenant = await models.Tenant.findOne({
      where: {service_type: SERVICE_TYPE, username}
    });
    if (tenant) {
      const data = this._tenantToMemory(tenant);
      this.tenantsCache.set(tenant.id, data);
      this.apiKeyHashMap.set(tenant.api_key_hash, tenant.id);
      return tenant.id;
    }
    return null;
  }

  /**
   * 删除租户及关联数据，清理缓存
   * @param {number} tenantId
   * @returns {Promise<boolean>}
   */
  async deleteTenant(tenantId) {
    tenantId = this._id(tenantId);
    if (!this.tenantsCache.has(tenantId)) return false;
    this.upstreamManagerCache.delete(tenantId);
    this._dirtyTenants.delete(tenantId);
    this._deltaTenants.delete(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
    this.apiKeyHashMap.delete(tenant.api_key_hash);
    this.tenantsCache.delete(tenantId);
    await models.Tenant.destroy({where: {id: tenantId}});
    logger.info(`Relay: Deleted tenant ${tenantId}`);
    return true;
  }

  /**
   * 重新生成 API Key
   * @param {number} tenantId
   * @returns {Promise<{apiKey: string}|null>}
   */
  async regenerateApiKey(tenantId) {
    tenantId = this._id(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
    if (!tenant) return null;
    const apiKey = this._generateApiKey();
    const newHash = this._hashApiKey(apiKey);
    const newPrefix = this._getApiKeyPrefix(apiKey);
    this.apiKeyHashMap.delete(tenant.api_key_hash);
    tenant.api_key_hash = newHash;
    tenant.api_key_prefix = newPrefix;
    tenant.api_key_plain = apiKey;
    this.apiKeyHashMap.set(newHash, tenantId);
    await models.Tenant.update(
      {api_key_hash: newHash, api_key_prefix: newPrefix, api_key_plain: apiKey},
      {where: {id: tenantId}}
    );
    logger.info(`Relay: Regenerated API key for tenant ${tenantId}`);
    return {apiKey};
  }

  /**
   * 列出所有租户信息
   * @returns {Promise<Array>}
   */
  async listTenants() {
    const results = [];
    for (const [tenantId, tenant] of this.tenantsCache) {
      const manager = await this.getUpstreamManager(tenantId);
      const upstreamCount = manager ? manager.getCount() : 0;
      const enabledCount = manager ? manager.getEnabledCount() : 0;
      results.push({
        tenantId,
        name: tenant.name,
        role: tenant.role || 'user',
        apiKeyPrefix: tenant.api_key_prefix,
        createdAt: tenant.created_at,
        upstreamCount,
        enabledCount,
        customApiCallCount: tenant.total_api_calls || 0,
        customInputTokens: tenant.total_input_tokens || 0,
        customOutputTokens: tenant.total_output_tokens || 0,
        customCacheHitTokens: tenant.total_cache_hit_tokens || 0
      });
    }
    return results;
  }

  /**
   * 获取单个租户详情
   * @param {number} tenantId
   * @returns {Promise<Object|null>}
   */
  async getTenant(tenantId) {
    tenantId = this._id(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
    if (!tenant) return null;
    const manager = await this.getUpstreamManager(tenantId);
    const upstreamCount = manager ? manager.getCount() : 0;
    const enabledCount = manager ? manager.getEnabledCount() : 0;
    return {
      tenantId,
      name: tenant.name,
      username: tenant.username,
      role: tenant.role || 'user',
      apiKeyPrefix: tenant.api_key_prefix,
      apiKeyPlain: tenant.api_key_plain || null,
      createdAt: tenant.created_at,
      is_key_personnel: !!tenant.is_key_personnel,
      upstreamCount,
      enabledCount,
      customApiCallCount: tenant.total_api_calls || 0,
      customInputTokens: tenant.total_input_tokens || 0,
      customOutputTokens: tenant.total_output_tokens || 0,
      customCacheHitTokens: tenant.total_cache_hit_tokens || 0
    };
  }

  // ===== 使用量统计方法 =====

  /**
   * 获取或初始化租户的增量追踪对象
   * @param {number} tenantId
   * @returns {Object}
   */
  _ensureDelta(tenantId) {
    if (!this._deltaTenants.has(tenantId)) {
      this._deltaTenants.set(tenantId, {
        api_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_hit_tokens: 0
      });
    }
    return this._deltaTenants.get(tenantId);
  }

  /**
   * 递增租户的 API 调用计数（内存中累计 + 增量追踪，定期 INCREMENT 刷盘）
   * @param {number} tenantId
   */
  incrementApiCallCount(tenantId) {
    tenantId = this._id(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
    if (!tenant) return;
    tenant.total_api_calls = (tenant.total_api_calls || 0) + 1;
    const delta = this._ensureDelta(tenantId);
    delta.api_calls++;
    this._dirtyTenants.add(tenantId);
  }

  /**
   * 累加租户的 token 使用量（内存中累计 + 增量追踪，定期 INCREMENT 刷盘）
   * @param {number} tenantId
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {number} [cacheHitTokens=0]
   */
  incrementTokenUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0) {
    tenantId = this._id(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
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
   * 重置租户的自定义统计数据（清零内存 + 增量 + 立即写 DB 0 + 广播通知其他进程）
   * 多进程安全：先 flush 所有进程的脏数据（通过广播触发），再清零 DB，最后广播让各进程从 DB 读取零值
   * @param {number} tenantId
   */
  async resetCustomStats(tenantId) {
    tenantId = this._id(tenantId);
    const tenant = this.tenantsCache.get(tenantId);
    if (!tenant) return;

    // 先 flush 本进程该租户的脏数据，确保已产生的统计不丢失
    const delta = this._deltaTenants.get(tenantId);
    if (delta) {
      const d = {
        total_api_calls: delta.api_calls || 0,
        total_input_tokens: delta.input_tokens || 0,
        total_output_tokens: delta.output_tokens || 0,
        total_cache_hit_tokens: delta.cache_hit_tokens || 0
      };
      delta.api_calls = 0;
      delta.input_tokens = 0;
      delta.output_tokens = 0;
      delta.cache_hit_tokens = 0;
      const hasDelta = d.total_api_calls || d.total_input_tokens || d.total_output_tokens || d.total_cache_hit_tokens;
      if (hasDelta) {
        try {
          await models.Tenant.increment(d, {where: {id: tenantId}});
        } catch (error) {
          logger.error(`Relay: Failed to flush before reset for tenant ${tenantId}: ${error.message}`);
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
        total_cache_hit_tokens: 0
      },
      {where: {id: tenantId}}
    );

    // 更新本进程内存
    tenant.total_api_calls = 0;
    tenant.total_input_tokens = 0;
    tenant.total_output_tokens = 0;
    tenant.total_cache_hit_tokens = 0;

    // 广播通知其他进程：先 flush 再从 DB 读取零值
    const {broadcast} = await import('../shared/cluster-broadcaster.js');
    broadcast('relay:stats:reset', {tenantId});
  }

  /**
   * 将未刷盘的统计强制写入数据库（进程退出前调用）
   */
  async flushApiCallCounts() {
    await this._flushDirtyTenants();
  }

  /**
   * 记录每日使用数据（每次 API 请求完成时调用）
   * @param {number} tenantId
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {number} [cacheHitTokens=0]
   * @param {string} [model='unknown']
   */
  async recordDailyUsage(tenantId, inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown') {
    tenantId = this._id(tenantId);
    if (!this.tenantsCache.has(tenantId)) return;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    try {
      const [record, created] = await models.TenantDailyUsage.findOrCreate({
        where: {
          tenant_id: tenantId,
          service_type: SERVICE_TYPE,
          model: model || 'unknown',
          date: dateStr
        },
        defaults: {
          api_calls: 1,
          input_tokens: inputTokens || 0,
          output_tokens: outputTokens || 0,
          input_cache_hit: cacheHitTokens || 0,
          input_cache_miss: (inputTokens || 0) - (cacheHitTokens || 0),
          credit: 0
        }
      });
      if (!created) {
        await record.increment({
          api_calls: 1,
          input_tokens: inputTokens || 0,
          output_tokens: outputTokens || 0,
          input_cache_hit: cacheHitTokens || 0,
          input_cache_miss: (inputTokens || 0) - (cacheHitTokens || 0)
        });
      }
    } catch (error) {
      logger.error(`Relay: Failed to record daily usage for tenant ${tenantId}: ${error.message}`);
    }
  }

  /**
   * 获取指定月份的每日使用数据
   * @param {number} tenantId
   * @param {string} monthKey - 格式 "YYYY-MM"
   * @returns {Promise<Object|null>}
   */
  async getDailyUsage(tenantId, monthKey) {
    tenantId = this._id(tenantId);
    try {
      const records = await models.TenantDailyUsage.findAll({
        where: {
          tenant_id: tenantId,
          service_type: SERVICE_TYPE,
          date: {[Op.like]: `${monthKey}%`}
        }
      });
      if (records.length === 0) return null;
      const result = {};
      for (const r of records) {
        const dayKey = r.date.slice(8); // "DD"
        result[dayKey] = {
          api_calls: r.api_calls,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_hit_tokens: r.input_cache_hit
        };
      }
      return result;
    } catch (error) {
      logger.error(`Relay: Failed to get daily usage for tenant ${tenantId}: ${error.message}`);
      return null;
    }
  }

  /**
   * 获取可用月份列表（近3个月，降序）
   * @param {number} tenantId
   * @returns {Promise<string[]>}
   */
  async getAvailableMonths(tenantId) {
    tenantId = this._id(tenantId);
    try {
      const records = await models.TenantDailyUsage.findAll({
        where: {tenant_id: tenantId, service_type: SERVICE_TYPE},
        attributes: ['date'],
        group: ['date'],
        order: [['date', 'DESC']],
        limit: 93
      });
      const months = new Set();
      for (const r of records) {
        months.add(r.date.slice(0, 7)); // "YYYY-MM"
      }
      return [...months].sort().reverse().slice(0, 3);
    } catch (error) {
      logger.error(`Relay: Failed to get available months for tenant ${tenantId}: ${error.message}`);
      return [];
    }
  }

  /**
   * 从数据库重新加载租户数据到内存，并广播通知其他进程同步
   */
  async reloadRegistry() {
    await this._flushDirtyTenants();
    await this._loadFromDb();
    logger.info('Relay: Tenant registry reloaded from database');

    // 广播通知其他进程同步
    const {broadcast} = await import('../shared/cluster-broadcaster.js');
    broadcast('relay:stats:refresh', {});
  }

  /**
   * 从数据库同步指定租户的统计数据到内存（收到广播通知后调用）
   * 先 flush 本进程的脏数据，再从 DB 读取最新值，确保多进程一致性
   * @param {number} [tenantId] - 租户 ID，不传则同步所有租户
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
          total_cache_hit_tokens: delta.cache_hit_tokens || 0
        };
        delta.api_calls = 0;
        delta.input_tokens = 0;
        delta.output_tokens = 0;
        delta.cache_hit_tokens = 0;
        const hasDelta = d.total_api_calls || d.total_input_tokens || d.total_output_tokens || d.total_cache_hit_tokens;
        if (hasDelta) {
          try {
            await models.Tenant.increment(d, {where: {id: this._id(tenantId)}});
          } catch (error) {
            logger.error(`Relay: Failed to flush before sync for tenant ${tenantId}: ${error.message}`);
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
        await models.Tenant.update(
          {total_api_calls: 0, total_input_tokens: 0, total_output_tokens: 0, total_cache_hit_tokens: 0},
          {where: {id: this._id(tenantId)}}
        );
      }
    }

    if (tenantId) {
      tenantId = this._id(tenantId);
      const tenant = this.tenantsCache.get(tenantId);
      if (!tenant) return;
      // 从 DB 读取最新统计值
      const dbTenant = await models.Tenant.findByPk(tenantId);
      if (!dbTenant) return;
      tenant.total_api_calls = dbTenant.total_api_calls || 0;
      tenant.total_input_tokens = dbTenant.total_input_tokens || 0;
      tenant.total_output_tokens = dbTenant.total_output_tokens || 0;
      tenant.total_cache_hit_tokens = dbTenant.total_cache_hit_tokens || 0;
      logger.info(`Relay: Synced stats from DB for tenant ${tenantId} (isReset=${isReset})`);
    } else {
      // 同步所有租户
      await this._loadFromDb();
      logger.info('Relay: Synced all tenant stats from DB');
    }
  }

  /**
   * 使指定租户的 UpstreamManager 缓存失效，下次请求时重新加载
   * 收到上游变更广播后调用
   * @param {number} tenantId
   */
  invalidateUpstreamCache(tenantId) {
    tenantId = this._id(tenantId);
    this.upstreamManagerCache.delete(tenantId);
    logger.info(`Relay: Invalidated upstream cache for tenant ${tenantId}`);
  }
}

export const tenantManager = new TenantManager();
export {TenantManager};
