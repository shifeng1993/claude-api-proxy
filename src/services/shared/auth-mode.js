/**
 * 鉴权模式选择器
 * 启动时探测 LDAP 服务器可达性，决定使用 'ldap' 还是 'local' 模式
 * @module services/shared/auth-mode
 */

import {Socket} from 'net';
import logger from '../../utils/logger.js';

const REQUIRED_LDAP_ENV = ['LDAP_SERVER', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN'];

/** @type {'ldap'|'local'|null} */
let _authMode = null;

/**
 * 仅供测试使用：重置内部状态
 */
export function _resetAuthModeForTest() {
    _authMode = null;
}

/**
 * 检查 LDAP 环境变量是否齐全
 * @returns {boolean}
 */
function isLdapConfigured() {
    return REQUIRED_LDAP_ENV.every(key => process.env[key]);
}

/**
 * TCP 探测 LDAP 服务器可达性
 * @param {string} ldapUrl - 形如 ldap://host:389 或 ldaps://host:636
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function detectLdapReachable(ldapUrl, timeoutMs = 3000) {
    return new Promise(resolve => {
        let host, port;
        try {
            const u = new URL(ldapUrl);
            host = u.hostname;
            port = parseInt(u.port, 10) || (u.protocol === 'ldaps:' ? 636 : 389);
            if (!host) {
                resolve(false);
                return;
            }
        } catch {
            resolve(false);
            return;
        }

        const socket = new Socket();
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(ok);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}

/**
 * 启动时一次性确定 authMode。幂等。
 * @returns {Promise<'ldap'|'local'>}
 */
export async function initAuthMode() {
    if (_authMode) return _authMode;

    if (!isLdapConfigured()) {
        logger.info('Auth mode: LDAP env not configured, using local accounts');
        _authMode = 'local';
        return _authMode;
    }

    const timeoutMs = parseInt(process.env.LDAP_PROBE_TIMEOUT_MS || '3000', 10);
    const reachable = await detectLdapReachable(process.env.LDAP_SERVER, timeoutMs);

    if (reachable) {
        logger.info(`Auth mode: LDAP reachable at ${process.env.LDAP_SERVER}, using LDAP`);
        _authMode = 'ldap';
    } else {
        logger.warn(`Auth mode: LDAP server ${process.env.LDAP_SERVER} unreachable, falling back to local accounts`);
        _authMode = 'local';
    }
    return _authMode;
}

/**
 * 获取当前 authMode。在 initAuthMode() 之前调用会抛错。
 * @returns {'ldap'|'local'}
 */
export function getAuthMode() {
    if (!_authMode) {
        throw new Error('initAuthMode() must be called before getAuthMode()');
    }
    return _authMode;
}