/**
 * Copilot API 服务
 * @module services/copilot/copilot-api
 */

import { request, readBody } from '../../utils/http-client.js';
import { getCopilotBaseUrl, copilotHeaders } from './config.js';
import logger from '../../utils/logger.js';

/**
 * 获取可用模型列表
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {string} accountType - 账户类型
 * @returns {Promise<object>}
 */
export async function getModels(copilotToken, vsCodeVersion, accountType = 'individual') {
    const baseUrl = getCopilotBaseUrl(accountType);
    const response = await request(`${baseUrl}/models`, {
        method: 'GET',
        headers: copilotHeaders(copilotToken, vsCodeVersion)
    });

    if (response.status !== 200) {
        throw new Error(`Failed to get models: ${response.status}`);
    }

    const body = await readBody(response.body);
    return JSON.parse(body);
}

/**
 * 创建 chat completions
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {object} payload - 请求负载
 * @param {string} accountType - 账户类型
 * @returns {Promise<{body: ReadableStream, headers: object, status: number}>}
 */
export async function createChatCompletions(copilotToken, vsCodeVersion, payload, accountType = 'individual') {
    const baseUrl = getCopilotBaseUrl(accountType);

    // 检查是否启用 vision
    const enableVision = payload.messages?.some(
        msg => typeof msg.content !== 'string' && 
               msg.content?.some(c => c.type === 'image_url')
    );

    // 检查是否为 agent 调用
    const isAgentCall = payload.messages?.some(
        msg => ['assistant', 'tool'].includes(msg.role)
    );

    const headers = {
        ...copilotHeaders(copilotToken, vsCodeVersion, enableVision),
        'X-Initiator': isAgentCall ? 'agent' : 'user'
    };

    logger.debug('Creating chat completions with payload:', JSON.stringify(payload).slice(0, 500));

    const response = await request(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (response.status >= 400) {
        const errorBody = await readBody(response.body);
        logger.error('Failed to create chat completions:', errorBody);
        throw new Error(`Failed to create chat completions: ${response.status} - ${errorBody}`);
    }

    return response;
}

/**
 * 创建 embeddings
 * @param {string} copilotToken - Copilot token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {object} payload - 请求负载
 * @param {string} accountType - 账户类型
 * @returns {Promise<object>}
 */
export async function createEmbeddings(copilotToken, vsCodeVersion, payload, accountType = 'individual') {
    const baseUrl = getCopilotBaseUrl(accountType);

    const response = await request(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: copilotHeaders(copilotToken, vsCodeVersion),
        body: JSON.stringify(payload)
    });

    if (response.status !== 200) {
        const errorBody = await readBody(response.body);
        logger.error('Failed to create embeddings:', errorBody);
        throw new Error(`Failed to create embeddings: ${response.status}`);
    }

    const body = await readBody(response.body);
    return JSON.parse(body);
}
