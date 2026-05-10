/**
 * Copilot 认证工具
 * @module services/copilot/auth
 */

import { getDeviceCode, pollAccessToken, getUser, getCopilotToken } from './github-api.js';
import { copilotState } from './state.js';
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
 * 轮询 GitHub 等待用户完成设备码授权
 * 授权成功后自动保存 GitHub token 和用户信息到 copilotState
 * @param {string} deviceCode - 设备代码
 * @param {number} interval - 轮询间隔（秒）
 * @param {number} expiresIn - 过期时间（秒）
 * @returns {Promise<{githubToken: string, userInfo: object}>}
 */
export async function pollDeviceAuth(deviceCode, interval, expiresIn) {
    logger.info('Polling for GitHub device authorization...');

    const tokenData = await pollAccessToken(deviceCode, interval, expiresIn);

    const githubToken = tokenData.access_token;
    copilotState.saveGithubToken(githubToken);

    const userInfo = await getUser(githubToken, copilotState.vsCodeVersion);
    copilotState.saveUserInfo(userInfo);

    logger.info(`Successfully authenticated as ${userInfo.login}`);

    return { githubToken, userInfo };
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

    logger.info('Refreshing Copilot token...');

    const tokenData = await getCopilotToken(
        copilotState.githubToken,
        copilotState.vsCodeVersion,
        proxyUrl
    );

    copilotState.saveCopilotToken(tokenData.token, tokenData.expires_at);
    logger.info('Successfully refreshed Copilot token');

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
