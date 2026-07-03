/**
 * 本地账号鉴权模块
 * 提供密码哈希、密码验证、本地账号登录
 * @module services/shared/local-auth
 */

import {randomBytes, scryptSync, timingSafeEqual} from 'crypto';
import logger from '../../utils/logger.js';
import {models} from '../../db/models/index.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024};

/**
 * 用 scrypt 哈希明文密码，返回 hex 字符串
 * @param {string} plain
 * @returns {{hash: string, salt: string}}
 */
export function hashPassword(plain) {
    if (typeof plain !== 'string' || plain.length === 0) {
        throw new TypeError('hashPassword: plain must be a non-empty string');
    }
    const salt = randomBytes(32).toString('hex');
    const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return {hash: derived.toString('hex'), salt};
}

/**
 * 用恒定时间比较验证密码
 * @param {string} plain
 * @param {string} hash - hex 字符串
 * @param {string} salt - hex 字符串
 * @returns {boolean}
 */
export function verifyPassword(plain, hash, salt) {
    if (!plain || !hash || !salt) return false;
    try {
        const expected = Buffer.from(hash, 'hex');
        const actual = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
        if (expected.length !== actual.length) return false;
        return timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

/**
 * 本地账号登录验证（跨端点：relay 和 codebuddy 共用同一套账号密码）
 * @param {string} username
 * @param {string} password
 * @param {Function} [findOne] - 测试注入用；默认从 models.Tenant 跨 service_type 查本地账号
 * @returns {Promise<{success: boolean, username?: string, displayName?: string, role?: string, message?: string}>}
 */
export async function localAuthenticate(username, password, findOne) {
    if (!username || !password) {
        return {success: false, message: '用户名或密码错误'};
    }

    try {
        let tenant;
        if (findOne) {
            tenant = await findOne();
        } else {
            tenant = await models.Tenant.findOne({where: {username}});
        }

        // 用户不存在 / LDAP 用户（无密码）→ 一律返回相同错误，避免用户枚举
        if (!tenant || !tenant.password_hash || !tenant.password_salt) {
            return {success: false, message: '用户名或密码错误'};
        }
        if (!verifyPassword(password, tenant.password_hash, tenant.password_salt)) {
            return {success: false, message: '用户名或密码错误'};
        }
        return {
            success: true,
            username: tenant.username,
            displayName: tenant.name || tenant.username,
            role: tenant.role || 'user'
        };
    } catch (err) {
        logger.error(`localAuthenticate error: ${err.message}`);
        return {success: false, message: '认证服务异常，请稍后重试'};
    }
}

/**
 * 启动时从环境变量初始化 admin 账号到 relay 和 codebuddy 两个通道
 * 若不存在则创建；若存在则同步密码（保证 env 改密码后重启即生效）
 * @returns {Promise<void>}
 */
export async function ensureAdminFromEnv() {
    const adminUser = process.env.LOCAL_ADMIN_USER;
    const adminPw = process.env.LOCAL_ADMIN_PASSWORD;
    if (!adminUser || !adminPw) {
        throw new Error('LOCAL_ADMIN_USER and LOCAL_ADMIN_PASSWORD must be set in env for local auth mode');
    }
    if (adminPw.length < 8) {
        throw new Error('LOCAL_ADMIN_PASSWORD must be at least 8 characters');
    }

    const {hash, salt} = hashPassword(adminPw);
    const {createHash, randomBytes} = await import('crypto');
    const {TenantServiceProfile} = await import('../../db/models/tenant-service-profile.js');

    const existing = await models.Tenant.findOne({where: {username: adminUser}});

    if (existing) {
        await models.Tenant.update(
            {password_hash: hash, password_salt: salt, role: 'superadmin'},
            {where: {id: existing.id}}
        );
        for (const [serviceType, enabled] of [['relay', true], ['codebuddy', true]]) {
            await TenantServiceProfile.findOrCreate({
                where: {tenant_id: existing.id, service_type: serviceType},
                defaults: {tenant_id: existing.id, service_type: serviceType, enabled}
            });
        }
        logger.info(`Local admin '${adminUser}' synced`);
    } else {
        const apiKey = 'sk-' + randomBytes(16).toString('hex');
        const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
        const body = apiKey.slice(3);
        const apiKeyPrefix = 'sk-' + body.slice(0, 8) + '****' + body.slice(-4);

        const tenant = await models.Tenant.create({
            name: adminUser,
            username: adminUser,
            api_key_hash: apiKeyHash,
            api_key_prefix: apiKeyPrefix,
            api_key_plain: apiKey,
            password_hash: hash,
            password_salt: salt,
            role: 'superadmin'
        });

        await TenantServiceProfile.bulkCreate([
            {tenant_id: tenant.id, service_type: 'relay', enabled: true},
            {tenant_id: tenant.id, service_type: 'codebuddy', enabled: true}
        ]);

        logger.info(`Local admin '${adminUser}' created with unified tenant (id=${tenant.id})`);
    }
}
