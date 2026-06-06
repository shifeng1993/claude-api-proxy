/**
 * 统一 API Key 鉴权模块
 * 替代 services/relay/auth.js 和 services/codebuddy/auth.js
 * @module services/gateway/gateway-auth
 */

import {createHash} from 'crypto';
import logger from '../../utils/logger.js';
import {extractTenantApiKey} from '../../utils/auth-headers.js';

/**
 * 从请求头鉴权租户 — 所有端点共用
 * @param {Object} headers - 请求头对象
 * @param {Object} tenantManager - 统一 TenantManager 实例
 * @returns {{tenantId: number}} | {{tenantId: null, skipAuth: boolean}} | {{error: {status: number, message: string}}}
 */
export function authenticateApiKey(headers, tenantManager) {
    if (!tenantManager || !tenantManager.isEnabled()) {
        return {tenantId: null, skipAuth: true};
    }

    const apiKey = extractTenantApiKey(headers);

    if (!apiKey) {
        return {error: {status: 401, message: 'Missing API key. Set Authorization: Bearer <key>'}};
    }

    const tenantId = tenantManager.authenticate(apiKey);
    if (tenantId === null) {
        logger.warn(`Gateway authentication failed: invalid API key`);
        return {error: {status: 401, message: 'Invalid API key'}};
    }

    return {tenantId};
}

/**
 * 根据 x-credential-id 请求头获取指定凭证
 * 未指定时返回第一个 enabled 凭证
 * @param {Object} headers
 * @param {Array<{id: number, enabled: boolean}>} credentials
 * @returns {Object|null}
 */
export function resolveCredential(headers, credentials) {
    if (!credentials || credentials.length === 0) return null;

    const specifiedId = headers['x-credential-id'];
    if (specifiedId) {
        const id = parseInt(specifiedId, 10);
        return credentials.find(c => c.id === id && c.enabled !== false) || null;
    }

    return credentials.find(c => c.enabled !== false) || null;
}

/**
 * SHA256 哈希辅助
 */
export function hashApiKey(apiKey) {
    return createHash('sha256').update(apiKey).digest('hex');
}
