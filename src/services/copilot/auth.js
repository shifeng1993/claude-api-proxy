/**
 * Copilot 认证工具
 * @module services/copilot/auth
 */

import { getDeviceCode, pollAccessToken, getUser, getCopilotToken } from './github-api.js';
import { copilotState } from './state.js';
import logger from '../../utils/logger.js';

/**
 * 执行 GitHub 设备认证流程
 * @returns {Promise<{githubToken: string, userInfo: object}>}
 */
export async function authenticateGitHub() {
    logger.info('Starting GitHub device authentication flow...');

    // 获取设备代码
    const deviceCodeData = await getDeviceCode();
    
    logger.info('Please visit:', deviceCodeData.verification_uri);
    logger.info('And enter code:', deviceCodeData.user_code);
    logger.info('Waiting for authorization...');

    // 轮询获取访问令牌
    const tokenData = await pollAccessToken(
        deviceCodeData.device_code,
        deviceCodeData.interval,
        deviceCodeData.expires_in
    );

    const githubToken = tokenData.access_token;
    copilotState.saveGithubToken(githubToken);

    // 获取用户信息
    const userInfo = await getUser(githubToken, copilotState.vsCodeVersion);
    copilotState.saveUserInfo(userInfo);

    logger.info(`Successfully authenticated as ${userInfo.login}`);

    return { githubToken, userInfo };
}

/**
 * 刷新 Copilot token
 * @returns {Promise<string>}
 */
export async function refreshCopilotToken() {
    if (!copilotState.githubToken) {
        throw new Error('GitHub token not found. Please authenticate first.');
    }

    logger.info('Refreshing Copilot token...');

    const tokenData = await getCopilotToken(
        copilotState.githubToken,
        copilotState.vsCodeVersion
    );

    copilotState.saveCopilotToken(tokenData.token, tokenData.expires_at);
    logger.info('Successfully refreshed Copilot token');

    return tokenData.token;
}

/**
 * 确保有有效的 Copilot token
 * @returns {Promise<string>}
 */
export async function ensureCopilotToken() {
    // 如果没有 GitHub token，需要先认证
    if (!copilotState.githubToken) {
        throw new Error('Not authenticated. Please authenticate first via /copilot/auth endpoint.');
    }

    // 如果 Copilot token 过期，刷新它
    if (copilotState.isCopilotTokenExpired()) {
        await refreshCopilotToken();
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
