/**
 * Copilot 认证工具
 * @module services/copilot/auth
 */

import {getDeviceCode, getUser, getCopilotToken} from './github-api.js';
import {copilotState} from './state.js';
import {request, readBody} from '../../utils/http-client.js';
import {GITHUB_BASE_URL, GITHUB_CLIENT_ID, standardHeaders} from './config.js';
import logger from '../../utils/logger.js';

/**
 * 启动 GitHub 设备码认证，返回设备码信息供 FE 展示
 * @returns {Promise<{device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number}>}
 */
export async function startDeviceAuth() {
    logger.info('Starting GitHub device authentication flow...');

    const deviceCodeData = await getDeviceCode();

    logger.info(`Device code generated: ${deviceCodeData.user_code}`);
    logger.info(`Verification URI: ${deviceCodeData.verification_uri}`);

    return deviceCodeData;
}

/**
 * 单次查询 GitHub 设备码授权状态
 * 由前端控制轮询频率，每次调用查一次 GitHub 立即返回
 * @param {string} deviceCode - 设备代码
 * @returns {Promise<{githubToken: string, userInfo: object}>}
 * @throws {Error} error.code 为 'authorization_pending' | 'slow_down' | 'expired_token'
 */
export async function pollDeviceAuth(deviceCode) {
    const response = await request(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
            ...standardHeaders(),
            accept: 'application/json'
        },
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
    });

    const body = await readBody(response.body);
    const data = JSON.parse(body);

    if (data.error) {
        const err = new Error(data.error_description || data.error);
        err.code = data.error;
        throw err;
    }

    if (data.access_token) {
        const githubToken = data.access_token;
        copilotState.saveGithubToken(githubToken);

        const userInfo = await getUser(githubToken, copilotState.vsCodeVersion);
        copilotState.saveUserInfo(userInfo);

        logger.info(`Successfully authenticated as ${userInfo.login}`);
        return {githubToken, userInfo};
    }

    const err = new Error('No access token in response');
    err.code = 'unknown';
    throw err;
}

/**
 * 刷新 Copilot token
 * @param {string} [proxyUrl] - 代理地址
 * @returns {Promise<string>}
 */
export async function refreshCopilotToken(proxyUrl) {
    if (!copilotState.githubToken) {
        throw new Error('GitHub token not found. Please authenticate first.');
    }

    const tokenData = await getCopilotToken(copilotState.githubToken, copilotState.vsCodeVersion, proxyUrl);

    copilotState.saveCopilotToken(tokenData.token, tokenData.expires_at);

    return tokenData.token;
}

/**
 * 确保有有效的 Copilot token
 * @param {string} [proxyUrl] - 代理地址
 * @returns {Promise<string>}
 */
export async function ensureCopilotToken(proxyUrl) {
    if (!copilotState.githubToken) {
        throw new Error('Not authenticated. Please visit /copilotFE to authenticate.');
    }

    if (copilotState.isCopilotTokenExpired()) {
        await refreshCopilotToken(proxyUrl);
    }

    return copilotState.copilotToken;
}

/**
 * 检查是否已认证
 * @returns {boolean}
 */
export function isAuthenticated() {
    return !!copilotState.githubToken;
}

/**
 * 清除认证状态
 */
export function clearAuthentication() {
    copilotState.clearState();
    logger.info('Authentication cleared');
}
