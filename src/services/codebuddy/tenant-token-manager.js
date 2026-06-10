/**
 * 租户 Token 管理器
 * 管理指定租户目录下的凭证，支持手动切换活跃凭证
 * 使用 Sequelize ORM 操作数据库替代文件系统读写
 * @module services/codebuddy/tenant-token-manager
 */

import logger from '../../utils/logger.js';
import {getCodebuddyBaseUrl, BLOCKED_DOMAINS} from './config.js';
import {models} from '../../db/models/index.js';

class TenantTokenManager {
    /**
     * @param {string} tenantDir - 租户目录绝对路径（保留兼容，不再用于文件读写）
     * @param {Object} [options] - 配置选项
     * @param {number} [options.tenantId] - 数据库中 tenant 的 id（数字）
     */
    constructor(tenantDir, options = {}) {
        this.tenantDir = tenantDir;
        this.tenantId = options.tenantId;

        this.credentials = [];
        this.currentIndex = 0;
        this.disabledIndexes = [];

        // 会话亲和性：conversationId → { index, lastAccess }
        // 同一会话始终使用同一凭证，避免凭证切换导致上游缓存 miss
        this.sessionAffinity = new Map();
    }

    /** 会话亲和映射过期时间（30分钟无活动自动清理） */
    static SESSION_AFFINITY_TTL = 30 * 60 * 1000;

    /**
     * 异步初始化：从数据库加载凭证和状态
     * 必须在构造后调用，或在工厂方法中使用
     */
    async init() {
        await this.loadAllTokens();
        await this.loadState();
        await this.disableBlockedDomainCredentials();
    }

    /**
     * 工厂方法：创建并初始化 TenantTokenManager 实例
     * @param {string} tenantDir
     * @param {Object} [options]
     * @returns {Promise<TenantTokenManager>}
     */
    static async create(tenantDir, options = {}) {
        const instance = new TenantTokenManager(tenantDir, options);
        await instance.init();
        return instance;
    }

    /**
     * 将 DB 记录映射为内存中的 data 结构（还原 user_info 嵌套）
     * @param {Object} record - TenantCredential DB 实例
     * @returns {Object}
     */
    _mapRecordToData(record) {
        return {
            bearer_token: record.bearer_token,
            refresh_token: record.refresh_token,
            token_type: record.token_type,
            user_id: record.user_id,
            user_info: {
                email: record.user_email,
                name: record.user_name
            },
            base_url: record.base_url,
            enterprise_id: record.enterprise_id,
            enterprise_name: record.enterprise_name,
            department_info: record.department_info,
            domain: record.domain,
            scope: record.scope,
            expires_in: record.expires_in,
            created_at: record.credential_created_at
        };
    }

    /**
     * 将内存 data 结构拆解为 DB 字段（拆开 user_info）
     * @param {Object} data - 凭证数据
     * @returns {Object}
     */
    _mapDataToRecord(data) {
        const userInfo = data.user_info || {};
        return {
            tenant_id: this.tenantId,
            bearer_token: data.bearer_token,
            refresh_token: data.refresh_token,
            token_type: data.token_type,
            user_id: data.user_id,
            user_email: userInfo.email || null,
            user_name: userInfo.name || null,
            base_url: data.base_url,
            enterprise_id: data.enterprise_id,
            enterprise_name: data.enterprise_name,
            department_info: data.department_info || '',
            domain: data.domain,
            scope: data.scope,
            expires_in: data.expires_in,
            credential_created_at: data.created_at || Math.floor(Date.now() / 1000),
            disabled: false
        };
    }

    /**
     * 加载所有 token 记录
     */
    async loadAllTokens() {
        this.credentials = [];
        this.currentIndex = 0;

        logger.debug(`Loading tenant credentials from DB for tenant_id: ${this.tenantId}`);

        try {
            const records = await models.TenantCredential.findAll({
                where: {tenant_id: this.tenantId},
                order: [['sort_order', 'ASC'], ['id', 'ASC']]
            });

            for (const record of records) {
                this.credentials.push({
                    id: record.id,
                    data: this._mapRecordToData(record),
                    disabled: record.disabled
                });
            }

            logger.debug(`Loaded ${this.credentials.length} tenant credentials`);
        } catch (error) {
            logger.error(`Failed to load tenant credentials from DB: ${error.message}`);
        }
    }

    /**
     * 加载管理器状态
     */
    async loadState() {
        try {
            const state = await models.TenantState.findOne({
                where: {tenant_id: this.tenantId}
            });

            if (!state) {
                logger.debug(`No saved state found for tenant_id: ${this.tenantId}`);
                return;
            }

            const savedDisabledIndexes = state.disabled_indexes;
            if (Array.isArray(savedDisabledIndexes)) {
                this.disabledIndexes = savedDisabledIndexes.filter(
                    (i) => i >= 0 && i < this.credentials.length
                );
            }

            if (state.current_index !== undefined) {
                if (state.current_index >= 0 && state.current_index < this.credentials.length) {
                    this.currentIndex = state.current_index;
                }
            }
        } catch (error) {
            logger.warn(`Failed to load tenant manager state: ${error.message}`);
        }
    }

    /**
     * 自动禁用包含已废弃域名的凭证，并切换到下一个可用凭证
     */
    async disableBlockedDomainCredentials() {
        if (BLOCKED_DOMAINS.length === 0 || this.credentials.length === 0) return;

        let changed = false;
        for (let i = 0; i < this.credentials.length; i++) {
            const baseUrl = getCodebuddyBaseUrl(this.credentials[i].data.base_url);
            const host = new URL(baseUrl).host;
            if (BLOCKED_DOMAINS.includes(host) && !this.disabledIndexes.includes(i)) {
                // 更新内存
                this.disabledIndexes.push(i);
                logger.debug(
                    `Auto-disabled credential #${i} (blocked domain: ${host}): id=${this.credentials[i].id}`
                );
                changed = true;

                // 更新 DB disabled 字段
                try {
                    await models.TenantCredential.update(
                        {disabled: true},
                        {where: {id: this.credentials[i].id}}
                    );
                } catch (error) {
                    logger.error(`Failed to update disabled flag in DB for credential #${i}: ${error.message}`);
                }
            }
        }

        if (changed) {
            // 当前凭证被禁用时，切换到下一个可用凭证
            if (this.disabledIndexes.includes(this.currentIndex)) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
            }
            await this.saveState();
        }
    }

    /**
     * 保存管理器状态
     */
    async saveState() {
        try {
            await models.TenantState.upsert({
                tenant_id: this.tenantId,
                current_index: this.currentIndex,
                disabled_indexes: this.disabledIndexes,
                saved_at: String(Date.now())
            });
        } catch (error) {
            logger.error(`Failed to save tenant manager state: ${error.message}`);
        }
    }

    /**
     * 检查 token 是否过期
     * @param {Object} credentialData
     * @returns {boolean}
     */
    isTokenExpired(credentialData) {
        const createdAt = credentialData.created_at;
        const expiresIn = credentialData.expires_in;

        if (!createdAt || !expiresIn) {
            return false;
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const expiryTime = createdAt + expiresIn;
        const bufferTime = 300;

        const isExpired = currentTime >= expiryTime - bufferTime;

        if (isExpired) {
            const userId = credentialData.user_id || 'unknown';
            logger.warn(`Token for user ${userId} is expired or will expire soon`);
        }

        return isExpired;
    }

    /**
     * 获取当前活跃凭证
     * 支持会话亲和性：传入 conversationId 时，同一会话始终返回同一凭证
     * @param {string} [conversationId] - 会话 ID，用于凭证亲和性
     * @returns {Object|null}
     */
    async getNextCredential(conversationId) {
        if (this.credentials.length === 0) {
            return null;
        }

        // 多进程环境下，其他进程可能已切换活跃凭证，先从数据库重新加载 currentIndex
        await this._reloadCurrentIndex();

        // 惰性清理过期的会话亲和映射
        this._cleanupSessionAffinity();

        // 会话亲和性：同一会话优先使用上次分配的凭证
        if (conversationId) {
            const affinity = this.sessionAffinity.get(conversationId);
            if (affinity) {
                const cred = this.credentials[affinity.index];
                if (cred && !this.disabledIndexes.includes(affinity.index) && !this.isTokenExpired(cred.data)) {
                    affinity.lastAccess = Date.now();
                    logger.debug(`Session affinity hit: conversationId=${conversationId}, credential index=${affinity.index}`);
                    return cred.data;
                }
                // 凭证已失效，清除亲和映射，下面重新分配
                this.sessionAffinity.delete(conversationId);
                logger.debug(`Session affinity expired: conversationId=${conversationId}, credential index=${affinity.index}`);
            }
        }

        // 确保当前活跃凭证可用
        if (
            this.currentIndex < 0 ||
            this.currentIndex >= this.credentials.length ||
            this.disabledIndexes.includes(this.currentIndex) ||
            this.isTokenExpired(this.credentials[this.currentIndex].data)
        ) {
            const nextAvailable = this.credentials.findIndex(
                (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
            );
            if (nextAvailable === -1) {
                return null;
            }
            this.currentIndex = nextAvailable;
        }

        const credential = this.credentials[this.currentIndex];
        if (conversationId) {
            this.sessionAffinity.set(conversationId, {index: this.currentIndex, lastAccess: Date.now()});
        }

        return credential.data;
    }

    /**
     * 从数据库重新加载 currentIndex，确保多进程环境下获取到最新的活跃凭证索引
     * 同时检测凭证数量变化，如果 DB 中的凭证数与内存不一致则重新加载全部凭证
     */
    async _reloadCurrentIndex() {
        try {
            const state = await models.TenantState.findOne({
                where: {tenant_id: this.tenantId}
            });

            // 检测凭证数量变化（其他进程可能增删了凭证）
            const dbCredentialCount = await models.TenantCredential.count({
                where: {tenant_id: this.tenantId}
            });
            if (dbCredentialCount !== this.credentials.length) {
                logger.info(`TenantTokenManager: 凭证数量变化 (内存=${this.credentials.length}, DB=${dbCredentialCount})，重新加载`);
                this.sessionAffinity.clear();
                await this.loadAllTokens();
                await this.loadState();
                return;
            }

            if (state && state.current_index !== undefined) {
                const newIndex = state.current_index;
                if (newIndex >= 0 && newIndex < this.credentials.length && !this.disabledIndexes.includes(newIndex)) {
                    if (this.currentIndex !== newIndex) {
                        logger.info(`TenantTokenManager: currentIndex 从 ${this.currentIndex} 更新为 ${newIndex} (来自数据库)`);
                        this.currentIndex = newIndex;
                    }
                }
            }
        } catch (error) {
            logger.warn(`_reloadCurrentIndex 失败: ${error.message}`);
        }
    }

    /**
     * 惰性清理过期的会话亲和映射
     * 在每次 getNextCredential 时顺便执行，不依赖定时器
     */
    _cleanupSessionAffinity() {
        if (this.sessionAffinity.size === 0) return;
        const now = Date.now();
        for (const [convId, affinity] of this.sessionAffinity) {
            if (now - affinity.lastAccess > TenantTokenManager.SESSION_AFFINITY_TTL) {
                this.sessionAffinity.delete(convId);
            }
        }
    }

    /**
     * 添加新凭证（完整数据）
     * @param {Object} credentialData
     * @param {string} [filename] - 保留参数兼容，不再使用
     * @returns {Promise<boolean>}
     */
    async addCredentialWithData(credentialData, filename = null) {
        if (!credentialData.created_at) {
            credentialData.created_at = Math.floor(Date.now() / 1000);
        }

        // 同一用户 + 同一 base_url 才视为重复凭证，更新而非新增
        // 不同企业站（不同 base_url）即使 user_id 相同也是独立凭证
        const userId = credentialData.user_id;
        const baseUrl = credentialData.base_url || '';
        if (userId) {
            const existing = this.credentials.find(
                (c) => c.data.user_id === userId && (c.data.base_url || '') === baseUrl
            );
            if (existing) {
                try {
                    const recordFields = this._mapDataToRecord(credentialData);
                    delete recordFields.tenant_id;
                    delete recordFields.disabled;
                    await models.TenantCredential.update(recordFields, {where: {id: existing.id}});
                    existing.data = this._mapRecordToData({...recordFields, id: existing.id, disabled: existing.disabled});
                    logger.debug(`Updated existing credential for user: ${userId}`);
                    await this.disableBlockedDomainCredentials();
                    return true;
                } catch (error) {
                    logger.error(`Failed to update credential: ${error.message}`);
                    return false;
                }
            }
        }

        try {
            const recordFields = this._mapDataToRecord(credentialData);
            recordFields.sort_order = this.credentials.length;
            const record = await models.TenantCredential.create(recordFields);
            this.credentials.push({
                id: record.id,
                data: this._mapRecordToData(record),
                disabled: record.disabled
            });
            logger.debug(`Added new tenant credential: id=${record.id}, user=${userId || 'unknown'}`);
            await this.disableBlockedDomainCredentials();
            return true;
        } catch (error) {
            logger.error(`Failed to save credential: ${error.message}`);
            return false;
        }
    }

    /**
     * 删除凭证
     * @param {number} index
     * @returns {Promise<boolean>}
     */
    async deleteCredential(index) {
        try {
            if (index < 0 || index >= this.credentials.length) {
                logger.error(`Invalid credential index for deletion: ${index}`);
                return false;
            }

            const cred = this.credentials[index];

            await models.TenantCredential.destroy({where: {id: cred.id}});
            logger.debug(`Deleted credential from DB: id=${cred.id}`);

            // 更新禁用索引：移除被删除的索引，大于它的索引减一
            this.disabledIndexes = this.disabledIndexes
                .filter((i) => i !== index)
                .map((i) => (i > index ? i - 1 : i));

            // 更新 currentIndex
            if (this.currentIndex === index) {
                this.currentIndex = 0;
            } else if (this.currentIndex > index) {
                this.currentIndex--;
            }

            // 清除可能指向被删除凭证的会话亲和映射
            const clearedCount = this.sessionAffinity.size;
            this.sessionAffinity.clear();
            if (clearedCount > 0) {
                logger.info(`Deleted credential #${index}: cleared ${clearedCount} session affinity mappings`);
            }

            this.credentials.splice(index, 1);
            await this.saveState();
            return true;
        } catch (error) {
            logger.error(`Failed to delete credential at index ${index}: ${error.message}`);
            return false;
        }
    }

    /**
     * 手动选择凭证
     * @param {number} index
     * @returns {Promise<boolean>}
     */
    async setActiveCredential(index) {
        if (index >= 0 && index < this.credentials.length) {
            this.currentIndex = index;
            const credId = this.credentials[index].id;
            // 用户主动切换活跃凭证时，清除所有会话亲和映射，确保立即生效
            const clearedCount = this.sessionAffinity.size;
            this.sessionAffinity.clear();
            logger.info(`Set active credential: id=${credId} (index: ${index}), cleared ${clearedCount} session affinity mappings`);
            await this.saveState();
            return true;
        } else {
            logger.error(`Invalid credential index: ${index}`);
            return false;
        }
    }

    async moveCredential(index, direction) {
        if (index < 0 || index >= this.credentials.length) {
            logger.error(`Invalid credential index for move: ${index}`);
            return false;
        }
        const targetIndex = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
        if (targetIndex < 0 || targetIndex >= this.credentials.length) {
            return false;
        }

        const movingId = this.credentials[index].id;
        const targetId = this.credentials[targetIndex].id;
        [this.credentials[index], this.credentials[targetIndex]] = [this.credentials[targetIndex], this.credentials[index]];

        const translateIndex = (value) => {
            if (value === index) return targetIndex;
            if (value === targetIndex) return index;
            return value;
        };
        this.currentIndex = translateIndex(this.currentIndex);
        this.disabledIndexes = this.disabledIndexes.map(translateIndex).sort((a, b) => a - b);

        await Promise.all(this.credentials.map((cred, sortOrder) => (
            models.TenantCredential.update({sort_order: sortOrder}, {where: {id: cred.id}})
        )));
        const clearedCount = this.sessionAffinity.size;
        this.sessionAffinity.clear();
        if (clearedCount > 0) {
            logger.info(`Moved credential ${movingId} around ${targetId}: cleared ${clearedCount} session affinity mappings`);
        }
        await this.saveState();
        return true;
    }

    /**
     * 切换凭证的启用/禁用状态
     * @param {number} index - 凭证索引
     * @returns {Promise<{disabled: boolean}>} 切换后的禁用状态
     */
    async toggleCredentialDisable(index) {
        if (index < 0 || index >= this.credentials.length) {
            logger.error(`Invalid credential index for toggle disable: ${index}`);
            return {disabled: false};
        }

        const cred = this.credentials[index];
        const newDisabled = !this.disabledIndexes.includes(index);

        // 更新内存
        if (newDisabled) {
            this.disabledIndexes.push(index);
            logger.debug(`Credential #${index} disabled: id=${cred.id}`);
            // 如果禁用的是当前活跃凭证，切换到下一个可用凭证，并清除会话亲和映射
            if (this.currentIndex === index) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
                const clearedCount = this.sessionAffinity.size;
                this.sessionAffinity.clear();
                if (clearedCount > 0) {
                    logger.info(`Disabled active credential #${index}: switched to #${this.currentIndex}, cleared ${clearedCount} session affinity mappings`);
                }
            }
        } else {
            const pos = this.disabledIndexes.indexOf(index);
            if (pos >= 0) {
                this.disabledIndexes.splice(pos, 1);
            }
            logger.debug(`Credential #${index} enabled: id=${cred.id}`);
        }

        // 更新 DB disabled 字段
        try {
            await models.TenantCredential.update(
                {disabled: newDisabled},
                {where: {id: cred.id}}
            );
        } catch (error) {
            logger.error(`Failed to update disabled flag in DB for credential #${index}: ${error.message}`);
        }

        await this.saveState();
        return {disabled: this.disabledIndexes.includes(index)};
    }

    /**
     * 获取所有凭证信息
     * @returns {Array}
     */
    getCredentialsInfo() {
        return this.credentials.map((cred, index) => {
            const data = cred.data;

            const isExpired = this.isTokenExpired(data);
            let expiresAt = null;
            let timeRemaining = null;

            if (data.created_at && data.expires_in) {
                expiresAt = data.created_at + data.expires_in;
                timeRemaining = expiresAt - Math.floor(Date.now() / 1000);
            }

            let timeRemainingStr = 'Unknown';
            if (timeRemaining !== null) {
                if (timeRemaining <= 0) {
                    timeRemainingStr = 'Expired';
                } else {
                    const days = Math.floor(timeRemaining / 86400);
                    const hours = Math.floor((timeRemaining % 86400) / 3600);
                    const minutes = Math.floor((timeRemaining % 3600) / 60);
                    timeRemainingStr =
                        days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                }
            }

            const userInfo = data.user_info || {};

            return {
                index,
                id: cred.id,
                userId: data.user_id || 'unknown',
                email: userInfo.email || data.user_id,
                name: userInfo.name,
                createdAt: data.created_at,
                expiresIn: data.expires_in,
                expiresAt,
                timeRemaining,
                timeRemainingStr,
                isExpired,
                isDisabled: this.disabledIndexes.includes(index),
                isDomainBlocked: BLOCKED_DOMAINS.includes(new URL(getCodebuddyBaseUrl(data.base_url)).host),
                tokenType: data.token_type || 'Bearer',
                scope: data.scope,
                domain: data.domain,
                enterpriseId: data.enterprise_id || '',
                enterpriseName: data.enterprise_name || '',
                departmentInfo: data.department_info || '',
                hasRefreshToken: !!data.refresh_token,
                baseUrl: getCodebuddyBaseUrl(data.base_url)
            };
        });
    }

    /**
     * 获取当前凭证信息
     * @returns {Object}
     */
    getCurrentCredentialInfo() {
        if (this.credentials.length === 0) {
            return {status: 'no_credentials'};
        }

        if (this.currentIndex < 0 || this.currentIndex >= this.credentials.length) {
            this.currentIndex = 0;
        }

        const credential = this.credentials[this.currentIndex];
        return {
            status: 'active',
            index: this.currentIndex,
            id: credential.id,
            userId: credential.data.user_id || 'unknown'
        };
    }

    /**
     * 检查是否有可用凭证
     * @returns {boolean}
     */
    hasCredentials() {
        return this.credentials.length > 0;
    }

    /**
     * 确保凭证目录存在（保留空方法以兼容外部调用）
     */
    ensureDirExists() {
        // DB 模式下不再需要创建目录，保留空方法兼容
    }
}

export {TenantTokenManager};
