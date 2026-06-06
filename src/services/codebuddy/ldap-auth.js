/**
 * LDAP 认证模块 — 两次绑定验证
 * @module services/codebuddy/ldap-auth
 */

import ldap from 'ldapjs';
import logger from '../../utils/logger.js';

const REQUIRED_ENV = ['LDAP_SERVER', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_BASE_DN'];

/**
 * 检查 LDAP 环境变量是否齐全
 * @returns {boolean}
 */
export function isLdapConfigured() {
    return REQUIRED_ENV.every(key => process.env[key]);
}

/**
 * 创建 ldapjs 客户端，自动处理 TLS 配置
 * @returns {ldap.Client}
 */
function createClient() {
    const url = process.env.LDAP_SERVER;
    const options = {
        url: [url],
        timeout: 5000,
        connectTimeout: 5000,
    };
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        options.tlsOptions = { rejectUnauthorized: false };
    }
    return ldap.createClient(options);
}

/**
 * 将 ldapjs bind 包装为 Promise
 */
function bindAsync(client, dn, password) {
    return new Promise((resolve, reject) => {
        client.bind(dn, password, err => (err ? reject(err) : resolve()));
    });
}

/**
 * 将 ldapjs search 包装为 Promise，返回所有条目
 */
function searchAsync(client, base, options) {
    return new Promise((resolve, reject) => {
        client.search(base, options, (err, res) => {
            if (err) {
                reject(err);
                return;
            }
            const entries = [];
            res.on('searchEntry', entry => entries.push(entry.pojo));
            res.on('error', reject);
            res.on('end', () => resolve(entries));
        });
    });
}

/**
 * 从搜索条目中提取第一个属性值
 */
function getAttr(entry, attrName) {
    const attr = entry.attributes?.find(a => a.type === attrName);
    return attr?.values?.[0] || '';
}

/**
 * LDAP 两次绑定认证
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{success: boolean, username?: string, displayName?: string, email?: string, message?: string}>}
 */
export async function ldapAuthenticate(username, password) {
    if (!isLdapConfigured()) {
        return { success: false, message: 'LDAP not configured' };
    }

    let client;

    try {
        // 第一次绑定：服务账号
        client = createClient();
        await bindAsync(client, process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD);
        logger.info(`LDAP service bind successful for user lookup: ${username}`);

        // 搜索用户
        const filter = process.env.LDAP_FILTER?.replace('{userNo}', username) || `(sAMAccountName=${username})`;
        const entries = await searchAsync(client, process.env.LDAP_BASE_DN, {
            scope: 'sub',
            filter,
            paged: true,
        });
        client.unbind();
        client = null;

        if (entries.length === 0) {
            return { success: false, message: '用户不存在' };
        }

        const userEntry = entries[0];
        const userDN = getAttr(userEntry, 'distinguishedName');
        const displayName = getAttr(userEntry, 'displayName') || getAttr(userEntry, 'cn') || getAttr(userEntry, 'name') || username;
        const email = getAttr(userEntry, 'mail');

        // 第二次绑定：用用户 DN + 密码验证
        client = createClient();
        try {
            await bindAsync(client, userDN, password);
            logger.info(`LDAP user authenticated: ${username}`);
            client.unbind();
            client = null;
            return { success: true, username, displayName, email };
        } catch {
            client.unbind();
            client = null;
            return { success: false, message: '用户名或密码错误' };
        }
    } catch (err) {
        logger.error(`LDAP authentication error: ${err.message}`);
        client?.unbind();
        if (err.message?.includes('No Such Object') || err.message?.includes('NoSuchObject')) {
            return { success: false, message: '用户不存在' };
        }
        return { success: false, message: '认证服务异常，请稍后重试' };
    }
}
