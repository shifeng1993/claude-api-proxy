/**
 * 租户 Token 管理器
 * 管理指定租户目录下的凭证，支持轮询使用
 * @module services/codebuddy/tenant-token-manager
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync} from 'fs';
import {join, basename} from 'path';
import logger from '../../utils/logger.js';
import {DEFAULT_BASE_URL} from './config.js';

class TenantTokenManager {
    /**
     * @param {string} tenantDir - 租户目录绝对路径
     * @param {Object} [options] - 配置选项
     * @param {number} [options.rotationCount=1] - 轮换次数阈值
     */
    constructor(tenantDir, options = {}) {
        this.tenantDir = tenantDir;
        this.credsDir = join(tenantDir, 'credentials');
        this.stateFile = join(tenantDir, 'state.json');

        this.credentials = [];
        this.currentIndex = 0;
        this.usageCount = 0;
        this.manualSelectedIndex = null;
        this.autoRotationEnabled = true;
        this.rotationCount = options.rotationCount ?? 1;
        this.disabledIndexes = [];

        this.ensureDirExists();
        this.loadAllTokens();
        this.loadState();
    }

    /**
     * 确保凭证目录存在
     */
    ensureDirExists() {
        if (!existsSync(this.credsDir)) {
            try {
                mkdirSync(this.credsDir, {recursive: true});
                logger.debug(`Created tenant credentials directory: ${this.credsDir}`);
            } catch (error) {
                logger.error(`Failed to create credentials directory: ${error.message}`);
            }
        }
    }

    /**
     * 加载所有 token 文件
     */
    loadAllTokens() {
        this.credentials = [];
        this.currentIndex = 0;

        logger.debug(`Loading tenant credentials from: ${this.credsDir}`);

        if (!existsSync(this.credsDir)) {
            logger.warn(`Credentials directory does not exist: ${this.credsDir}`);
            return;
        }

        try {
            const files = readdirSync(this.credsDir);
            const tokenFiles = files.filter((f) => f.endsWith('.json') && f !== 'state.json');

            for (const file of tokenFiles) {
                try {
                    const filePath = join(this.credsDir, file);
                    const content = readFileSync(filePath, 'utf8');
                    const data = JSON.parse(content);

                    if (data.bearer_token) {
                        this.credentials.push({filePath, data});
                        logger.debug(`Loaded tenant credential: ${file}`);
                    } else {
                        logger.warn(`Skipping invalid credential file (missing bearer_token): ${file}`);
                    }
                } catch (error) {
                    logger.error(`Failed to load credential file ${file}: ${error.message}`);
                }
            }

            logger.debug(`Loaded ${this.credentials.length} tenant credentials`);
        } catch (error) {
            logger.error(`Failed to read credentials directory: ${error.message}`);
        }
    }

    /**
     * 加载管理器状态
     */
    loadState() {
        try {
            if (existsSync(this.stateFile)) {
                const content = readFileSync(this.stateFile, 'utf8');
                const state = JSON.parse(content);

                const savedManualIndex = state.manualSelectedIndex;
                if (
                    savedManualIndex !== null &&
                    savedManualIndex !== undefined &&
                    savedManualIndex >= 0 &&
                    savedManualIndex < this.credentials.length
                ) {
                    this.manualSelectedIndex = savedManualIndex;
                    this.currentIndex = savedManualIndex;
                    logger.debug(`Restored manual selection: index ${savedManualIndex}`);
                }

                if (state.autoRotationEnabled !== undefined) {
                    this.autoRotationEnabled = state.autoRotationEnabled;
                }

                if (state.rotationCount !== undefined) {
                    this.rotationCount = state.rotationCount;
                }

                if (Array.isArray(state.disabledIndexes)) {
                    this.disabledIndexes = state.disabledIndexes.filter(
                        i => i >= 0 && i < this.credentials.length
                    );
                }

                if (this.manualSelectedIndex === null && state.currentIndex !== undefined) {
                    if (state.currentIndex >= 0 && state.currentIndex < this.credentials.length) {
                        this.currentIndex = state.currentIndex;
                    }
                }
            }
        } catch (error) {
            logger.warn(`Failed to load tenant manager state: ${error.message}`);
        }
    }

    /**
     * 保存管理器状态
     */
    saveState() {
        try {
            this.ensureDirExists();

            const state = {
                autoRotationEnabled: this.autoRotationEnabled,
                currentIndex: this.currentIndex,
                manualSelectedIndex: this.manualSelectedIndex,
                rotationCount: this.rotationCount,
                disabledIndexes: this.disabledIndexes,
                savedAt: Date.now()
            };

            writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
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
     * 获取下一个可用的凭证
     * @returns {Object|null}
     */
    getNextCredential() {
        if (this.credentials.length === 0) {
            return null;
        }

        const validCredentials = [];
        for (let i = 0; i < this.credentials.length; i++) {
            if (this.disabledIndexes.includes(i)) {
                logger.warn(`Skipping disabled credential: ${basename(this.credentials[i].filePath)}`);
                continue;
            }
            if (!this.isTokenExpired(this.credentials[i].data)) {
                validCredentials.push({index: i, credential: this.credentials[i]});
            } else {
                logger.warn(`Skipping expired credential: ${basename(this.credentials[i].filePath)}`);
            }
        }

        if (validCredentials.length === 0) {
            logger.error('No valid (non-expired) credentials available');
            return null;
        }

        const currentValidIndices = validCredentials.map((vc) => vc.index);
        if (!currentValidIndices.includes(this.currentIndex)) {
            this.currentIndex = currentValidIndices[0];
            this.usageCount = 0;
            logger.debug(`Reset to first valid credential index: ${this.currentIndex}`);
        }

        if (
            this.manualSelectedIndex !== null &&
            this.manualSelectedIndex >= 0 &&
            this.manualSelectedIndex < this.credentials.length
        ) {
            if (this.disabledIndexes.includes(this.manualSelectedIndex)) {
                logger.warn('Manually selected credential is disabled, falling back to automatic rotation');
                this.manualSelectedIndex = null;
            } else {
                const manualCred = this.credentials[this.manualSelectedIndex];
                if (!this.isTokenExpired(manualCred.data)) {
                    logger.debug(`Using manually selected credential: ${basename(manualCred.filePath)}`);
                    return manualCred.data;
                } else {
                    logger.warn('Manually selected credential is expired, falling back to automatic rotation');
                    this.manualSelectedIndex = null;
                }
            }
        }

        const shouldRotate = this.autoRotationEnabled && this.rotationCount > 0;

        if (!shouldRotate) {
            const credential = this.credentials[this.currentIndex];
            logger.debug(`Using fixed credential: ${basename(credential.filePath)}`);
            return credential.data;
        }

        if (this.usageCount >= this.rotationCount) {
            const currentValidPosition = currentValidIndices.indexOf(this.currentIndex);
            const nextValidPosition = (currentValidPosition + 1) % validCredentials.length;
            this.currentIndex = currentValidIndices[nextValidPosition];
            this.usageCount = 0;
        }

        const credential = this.credentials[this.currentIndex];
        this.usageCount++;

        return credential.data;
    }

    /**
     * 添加新凭证（完整数据）
     * @param {Object} credentialData
     * @param {string} [filename]
     * @returns {boolean}
     */
    addCredentialWithData(credentialData, filename = null) {
        if (!credentialData.created_at) {
            credentialData.created_at = Math.floor(Date.now() / 1000);
        }

        // 同一用户只保留最新凭证，更新而非新增
        const userId = credentialData.user_id;
        if (userId) {
            const existing = this.credentials.find(c => c.data.user_id === userId);
            if (existing) {
                try {
                    this.ensureDirExists();
                    writeFileSync(existing.filePath, JSON.stringify(credentialData, null, 4), 'utf8');
                    logger.debug(`Updated existing credential for user: ${userId}`);
                    this.loadAllTokens();
                    return true;
                } catch (error) {
                    logger.error(`Failed to update credential: ${error.message}`);
                    return false;
                }
            }
        }

        if (!filename) {
            const timestamp = credentialData.created_at;
            const safeUserId = String(userId || 'unknown')
                .replace(/[^a-zA-Z0-9._-]/g, '')
                .slice(0, 20);
            filename = `codebuddy_${safeUserId}_${timestamp}.json`;
        }

        if (!filename.endsWith('.json')) {
            filename += '.json';
        }

        const filePath = join(this.credsDir, filename);

        try {
            this.ensureDirExists();
            writeFileSync(filePath, JSON.stringify(credentialData, null, 4), 'utf8');
            logger.debug(`Added new tenant credential: ${filename}`);
            this.loadAllTokens();
            return true;
        } catch (error) {
            logger.error(`Failed to save credential: ${error.message}`);
            return false;
        }
    }

    /**
     * 删除凭证
     * @param {number} index
     * @returns {boolean}
     */
    deleteCredential(index) {
        try {
            if (index < 0 || index >= this.credentials.length) {
                logger.error(`Invalid credential index for deletion: ${index}`);
                return false;
            }

            const filePath = this.credentials[index].filePath;
            const filename = basename(filePath);

            if (existsSync(filePath)) {
                unlinkSync(filePath);
                logger.debug(`Deleted credential file: ${filename}`);
            } else {
                logger.warn(`Credential file already missing: ${filename}`);
            }

            if (this.manualSelectedIndex === index) {
                this.manualSelectedIndex = null;
                logger.debug('Cleared manual selection because deleted credential was selected');
            } else if (this.manualSelectedIndex !== null && this.manualSelectedIndex > index) {
                this.manualSelectedIndex--;
            }

            // 更新禁用索引：移除被删除的索引，大于它的索引减一
            this.disabledIndexes = this.disabledIndexes
                .filter(i => i !== index)
                .map(i => i > index ? i - 1 : i);

            this.loadAllTokens();
            return true;
        } catch (error) {
            logger.error(`Failed to delete credential at index ${index}: ${error.message}`);
            return false;
        }
    }

    /**
     * 手动选择凭证
     * @param {number} index
     * @returns {boolean}
     */
    setManualCredential(index) {
        if (index >= 0 && index < this.credentials.length) {
            this.manualSelectedIndex = index;
            this.currentIndex = index;
            const filename = basename(this.credentials[index].filePath);
            logger.debug(`Manually selected credential: ${filename} (index: ${index})`);
            this.saveState();
            return true;
        } else {
            logger.error(`Invalid credential index: ${index}`);
            return false;
        }
    }

    /**
     * 清除手动选择
     */
    clearManualSelection() {
        this.manualSelectedIndex = null;
        logger.debug('Cleared manual credential selection, resumed automatic rotation');
        this.saveState();
    }

    /**
     * 修改轮换次数
     * @param {number} count
     */
    setRotationCount(count) {
        this.rotationCount = Math.max(1, parseInt(count, 10) || 1);
        this.saveState();
        logger.debug(`Rotation count set to: ${this.rotationCount}`);
    }

    /**
     * 设置自动轮换
     * @param {boolean} enabled
     * @returns {boolean}
     */
    setAutoRotation(enabled) {
        this.autoRotationEnabled = !!enabled;
        this.saveState();
        return this.autoRotationEnabled;
    }

    /**
     * 切换自动轮换
     * @returns {boolean}
     */
    toggleAutoRotation() {
        this.autoRotationEnabled = !this.autoRotationEnabled;
        const status = this.autoRotationEnabled ? 'enabled' : 'disabled';
        logger.debug(`Auto rotation toggled: ${status}`);
        this.saveState();
        return this.autoRotationEnabled;
    }

    /**
     * 切换凭证的启用/禁用状态
     * @param {number} index - 凭证索引
     * @returns {{disabled: boolean}} 切换后的禁用状态
     */
    toggleCredentialDisable(index) {
        if (index < 0 || index >= this.credentials.length) {
            logger.error(`Invalid credential index for toggle disable: ${index}`);
            return {disabled: false};
        }

        const pos = this.disabledIndexes.indexOf(index);
        if (pos >= 0) {
            this.disabledIndexes.splice(pos, 1);
            logger.debug(`Credential #${index} enabled: ${basename(this.credentials[index].filePath)}`);
        } else {
            this.disabledIndexes.push(index);
            logger.debug(`Credential #${index} disabled: ${basename(this.credentials[index].filePath)}`);
            // 如果禁用的是当前手动选中的凭证，清除手动选择
            if (this.manualSelectedIndex === index) {
                this.manualSelectedIndex = null;
            }
            // 如果禁用的是当前轮换到的凭证，重置到下一个可用凭证
            if (this.currentIndex === index) {
                const nextAvailable = this.credentials.findIndex(
                    (_, i) => !this.disabledIndexes.includes(i) && !this.isTokenExpired(this.credentials[i].data)
                );
                this.currentIndex = nextAvailable >= 0 ? nextAvailable : 0;
                this.usageCount = 0;
            }
        }

        this.saveState();
        return {disabled: this.disabledIndexes.includes(index)};
    }

    /**
     * 获取所有凭证信息
     * @returns {Array}
     */
    getCredentialsInfo() {
        return this.credentials.map((cred, index) => {
            const data = cred.data;
            const filename = basename(cred.filePath);

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
                filename,
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
                tokenType: data.token_type || 'Bearer',
                scope: data.scope,
                domain: data.domain,
                hasRefreshToken: !!data.refresh_token,
                baseUrl: data.base_url || DEFAULT_BASE_URL,
                enterpriseId: data.enterprise_id || '',
                departmentInfo: data.department_info || ''
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

        if (
            this.manualSelectedIndex !== null &&
            this.manualSelectedIndex >= 0 &&
            this.manualSelectedIndex < this.credentials.length
        ) {
            const credential = this.credentials[this.manualSelectedIndex];
            return {
                status: 'manual_selected',
                index: this.manualSelectedIndex,
                filename: basename(credential.filePath),
                userId: credential.data.user_id || 'unknown'
            };
        }

        if (this.currentIndex < 0 || this.currentIndex >= this.credentials.length) {
            this.currentIndex = 0;
        }

        if (!this.autoRotationEnabled) {
            const credential = this.credentials[this.currentIndex];
            return {
                status: 'auto_rotation_disabled',
                index: this.currentIndex,
                filename: basename(credential.filePath),
                userId: credential.data.user_id || 'unknown',
                rotationCount: this.rotationCount,
                autoRotationEnabled: false
            };
        }

        const credential = this.credentials[this.currentIndex];
        return {
            status: 'auto_rotation',
            index: this.currentIndex,
            filename: basename(credential.filePath),
            userId: credential.data.user_id || 'unknown',
            usageCount: this.usageCount,
            rotationCount: this.rotationCount,
            autoRotationEnabled: true
        };
    }

    /**
     * 检查是否有可用凭证
     * @returns {boolean}
     */
    hasCredentials() {
        return this.credentials.length > 0;
    }
}

export {TenantTokenManager};
