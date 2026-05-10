/**
 * Relay 单租户鉴权
 * @module services/relay/auth
 */

import logger from '../../utils/logger.js';
import {relayStore} from './relay-store.js';

/**
 * 鉴权请求
 * @param {Object} headers - 请求头对象
 * @returns {Object} 鉴权结果：{authenticated: true} | {authenticated: false, error}
 */
export function authenticateRequest(headers) {
    const apiKey = headers['x-api-key'] ||
        (headers['authorization']?.startsWith('Bearer ') ? headers['authorization'].slice(7) : null);

    if (!apiKey) {
        return {authenticated: false, error: 'Missing API key. Set x-api-key or Authorization: Bearer <key>'};
    }

    if (!relayStore.authenticate(apiKey)) {
        logger.warn('Relay authentication failed: invalid API key');
        return {authenticated: false, error: 'Invalid API key'};
    }

    return {authenticated: true};
}
