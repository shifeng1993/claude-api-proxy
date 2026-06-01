/**
 * 核心凭证验证
 * 管理员登录验证、网关令牌验证
 * 首次运行自动生成凭证并持久化到 .gateway/ 目录
 * @module services/gateway/auth
 */

import {createHash, randomBytes} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {rsaKeyManager} from './rsa-keys.js';
import logger from '../../utils/logger.js';

const GATEWAY_DIR = '.gateway';
const ADMIN_CRED_FILE = 'admin_credentials.json';
const GATEWAY_TOKEN_FILE = 'gateway_token.json';

// 缓存的配置值
let adminUsername = 'admin';
let adminPasswordHash = null;
let gatewayToken = null;
let gatewayTokenHash = null;
let gatewayTokenPrefix = null;
let _initialized = false;

/**
 * 生成随机密码（8 位，字母数字混合，易读）
 * @returns {string}
 */
function generatePassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(12);
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars[bytes[i] % chars.length];
    }
    return password;
}

/**
 * 生成网关令牌（格式：sk-gateway-xxx）
 * @returns {string}
 */
function generateGatewayToken() {
    return 'sk-gateway-' + randomBytes(16).toString('hex');
}

/**
 * 加载或生成管理员凭证
 */
function _loadAdminCredentials() {
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const credFile = join(baseDir, ADMIN_CRED_FILE);

    // 环境变量优先
    if (process.env.ADMIN_PASSWORD_HASH) {
        adminUsername = process.env.ADMIN_USERNAME || 'admin';
        adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
        logger.info('Admin credentials loaded from ADMIN_PASSWORD_HASH env');
        return;
    }
    if (process.env.ADMIN_PASSWORD) {
        adminUsername = process.env.ADMIN_USERNAME || 'admin';
        adminPasswordHash = createHash('sha256').update(process.env.ADMIN_PASSWORD).digest('hex');
        logger.warn('ADMIN_PASSWORD is set in plaintext. Consider using ADMIN_PASSWORD_HASH instead.');
        return;
    }

    // 从文件加载
    if (existsSync(credFile)) {
        try {
            const data = JSON.parse(readFileSync(credFile, 'utf8'));
            adminUsername = data.username || 'admin';
            adminPasswordHash = data.password_hash;
            if (adminPasswordHash) {
                logger.info('Admin credentials loaded from disk');
                return;
            }
        } catch (err) {
            logger.warn('Failed to load admin credentials:', err.message);
        }
    }

    // 自动生成
    if (!existsSync(baseDir)) {
        mkdirSync(baseDir, {recursive: true});
    }

    adminUsername = 'admin';
    const password = generatePassword();
    adminPasswordHash = createHash('sha256').update(password).digest('hex');

    writeFileSync(credFile, JSON.stringify({
        username: adminUsername,
        password_hash: adminPasswordHash,
        created_at: new Date().toISOString()
    }, null, 2), 'utf8');

    logger.info('========================================');
    logger.info('  Admin credentials auto-generated');
    logger.info(`  Username: ${adminUsername}`);
    logger.info(`  Password: ${password}`);
    logger.info('  Please save this password, it will not be shown again.');
    logger.info('========================================');
}

/**
 * 加载或生成网关令牌
 */
function _loadGatewayToken() {
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const tokenFile = join(baseDir, GATEWAY_TOKEN_FILE);

    // 环境变量优先
    if (process.env.GATEWAY_TOKEN) {
        gatewayToken = process.env.GATEWAY_TOKEN;
        gatewayTokenHash = createHash('sha256').update(gatewayToken).digest('hex');
        gatewayTokenPrefix = gatewayToken.substring(0, 12) + '****';
        logger.info('Gateway token loaded from GATEWAY_TOKEN env');
        return;
    }

    // 从文件加载
    if (existsSync(tokenFile)) {
        try {
            const data = JSON.parse(readFileSync(tokenFile, 'utf8'));
            gatewayTokenHash = data.token_hash;
            gatewayTokenPrefix = data.token_prefix;
            if (gatewayTokenHash) {
                logger.info('Gateway token loaded from disk');
                return;
            }
        } catch (err) {
            logger.warn('Failed to load gateway token:', err.message);
        }
    }

    // 自动生成
    if (!existsSync(baseDir)) {
        mkdirSync(baseDir, {recursive: true});
    }

    gatewayToken = generateGatewayToken();
    gatewayTokenHash = createHash('sha256').update(gatewayToken).digest('hex');
    gatewayTokenPrefix = gatewayToken.substring(0, 12) + '****';

    writeFileSync(tokenFile, JSON.stringify({
        token_hash: gatewayTokenHash,
        token_prefix: gatewayTokenPrefix,
        created_at: new Date().toISOString()
    }, null, 2), 'utf8');

    logger.info('========================================');
    logger.info('  Gateway token auto-generated');
    logger.info(`  Token: ${gatewayToken}`);
    logger.info('  Please save this token, it will not be shown again.');
    logger.info('========================================');
}

/**
 * 初始化鉴权配置
 */
export function initGatewayAuth() {
    if (_initialized) return;

    // 确保 RSA 密钥对已初始化
    rsaKeyManager.init();

    // 加载或生成管理员凭证
    _loadAdminCredentials();

    // 加载或生成网关令牌
    _loadGatewayToken();

    _initialized = true;
}

/**
 * 管理后台认证是否启用
 * @returns {boolean}
 */
export function isAdminAuthEnabled() {
    return adminPasswordHash !== null;
}

/**
 * 网关令牌认证是否启用
 * @returns {boolean}
 */
export function isGatewayAuthEnabled() {
    return gatewayTokenHash !== null;
}

/**
 * 获取网关令牌哈希（供各 store 透传使用）
 * @returns {string|null}
 */
export function getGatewayTokenHash() {
    return gatewayTokenHash;
}

/**
 * 获取网关令牌前缀（用于日志显示）
 * @returns {string|null}
 */
export function getGatewayTokenPrefix() {
    return gatewayTokenPrefix;
}

/**
 * 验证管理员凭证
 * @param {string} username - 用户名
 * @param {string} encryptedPassword - RSA 加密后的密码（Base64）
 * @returns {{valid: boolean, error?: string}}
 */
export function verifyAdminCredentials(username, encryptedPassword) {
    if (!isAdminAuthEnabled()) {
        return {valid: false, error: 'Admin authentication is not configured'};
    }

    // 验证用户名
    if (username !== adminUsername) {
        return {valid: false, error: 'Invalid credentials'};
    }

    // RSA 解密密码
    const password = rsaKeyManager.decrypt(encryptedPassword);
    if (password === null) {
        return {valid: false, error: 'Decryption failed'};
    }

    // SHA256 哈希比对
    const hash = createHash('sha256').update(password).digest('hex');
    if (hash === adminPasswordHash) {
        logger.info(`Admin login successful: ${username}`);
        return {valid: true};
    }

    return {valid: false, error: 'Invalid credentials'};
}

/**
 * 验证网关令牌
 * @param {string} token - 客户端提供的令牌
 * @returns {boolean}
 */
export function verifyGatewayToken(token) {
    if (!isGatewayAuthEnabled()) return false;
    const hash = createHash('sha256').update(token).digest('hex');
    return hash === gatewayTokenHash;
}

/**
 * 从请求头提取并验证网关令牌
 * @param {object} headers - HTTP 请求头
 * @returns {{authenticated: boolean, error?: string}}
 */
export function authenticateGatewayRequest(headers) {
    if (!isGatewayAuthEnabled()) {
        return {authenticated: false, error: 'Gateway authentication is not configured'};
    }

    // 提取 token：优先 Authorization: Bearer，兼容 x-api-key
    let token = null;
    const auth = headers['authorization'];
    if (auth) {
        token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    }
    if (!token) {
        token = headers['x-api-key'];
    }

    if (!token) {
        return {authenticated: false, error: 'Missing API key. Set Authorization: Bearer <token>'};
    }

    if (!verifyGatewayToken(token)) {
        logger.warn('Gateway authentication failed: invalid token');
        return {authenticated: false, error: 'Invalid gateway token'};
    }

    return {authenticated: true};
}
