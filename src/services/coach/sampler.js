/**
 * 采样器
 * 对重点人员的 API 请求进行概率采样，异步写入文件系统
 * @module services/coach/sampler
 */

import {sanitize} from './sanitizer.js';
import {saveSample} from './storage.js';
import {unifiedTenantManager} from '../gateway/tenant-manager.js';
import {models} from '../../db/models/index.js';
import logger from '../../utils/logger.js';

const SAMPLE_RATE = parseFloat(process.env.COACH_SAMPLE_RATE || '0.2');

/**
 * 获取租户管理器映射
 */
function getTenantManagerMap() {
    return {
        codebuddy: unifiedTenantManager,
        relay: unifiedTenantManager
    };
}

/**
 * 判断租户是否为重点人员
 * @param {string|number} tenantId - 'tenant_X' 或数字ID
 * @param {string} serviceType
 * @returns {Promise<boolean>}
 */
async function isKeyPersonnel(tenantId, serviceType) {
    const managers = getTenantManagerMap();
    const manager = managers[serviceType];
    if (!manager || !manager.isEnabled()) return false;

    const tenant = await manager.getTenant(tenantId);
    return !!tenant?.is_key_personnel;
}

/**
 * 获取租户的用户名
 * @param {string|number} tenantId
 * @param {string} serviceType
 * @returns {Promise<string|null>}
 */
async function getTenantUsername(tenantId, serviceType) {
    const managers = getTenantManagerMap();
    const manager = managers[serviceType];
    if (!manager || !manager.isEnabled()) return null;

    const tenant = await manager.getTenant(tenantId);
    return tenant?.username || null;
}

/**
 * 对 API 请求进行采样
 * 完全异步，不阻塞主流程，失败不影响 API 响应
 *
 * @param {string|number} tenantId
 * @param {string} serviceType - 'codebuddy' | 'relay'
 * @param {object} payload - 请求体
 * @param {object|null} response - 响应体（流式时为 null）
 * @param {string} [model='unknown']
 * @returns {Promise<void>}
 */
export async function sampleRequest(tenantId, serviceType, payload, response = null, model = 'unknown') {
    try {
        // 1. 检查是否为重点人员
        if (!(await isKeyPersonnel(tenantId, serviceType))) return;

        // 2. 概率采样
        if (Math.random() >= SAMPLE_RATE) return;

        const username = await getTenantUsername(tenantId, serviceType);

        // 3. 脱敏处理
        const sanitizedRequest = sanitize(payload);
        const sanitizedResponse = response ? sanitize(response) : null;

        // 4. 构造采样数据
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        let inputTokens = 0;
        let outputTokens = 0;

        // 尝试从响应中提取 token 用量
        if (sanitizedResponse?.usage) {
            inputTokens = sanitizedResponse.usage.prompt_tokens || sanitizedResponse.usage.input_tokens || 0;
            outputTokens = sanitizedResponse.usage.completion_tokens || sanitizedResponse.usage.output_tokens || 0;
        }

        const sampleData = {
            tenant_id: typeof tenantId === 'string' ? parseInt(tenantId.replace('tenant_', ''), 10) : tenantId,
            username,
            service_type: serviceType,
            model,
            timestamp: now.toISOString(),
            request: sanitizedRequest,
            response: sanitizedResponse,
            sanitized: true,
            sample_rate: SAMPLE_RATE
        };

        // 5. 异步写入文件
        const {relativePath} = await saveSample(tenantId, dateStr, sampleData);

        // 6. 写数据库元数据
        try {
            const numericId = typeof tenantId === 'string' ? parseInt(tenantId.replace('tenant_', ''), 10) : tenantId;
            await models.ApiSample.create({
                tenant_id: numericId,
                service_type: serviceType,
                username,
                model,
                file_path: relativePath,
                request_tokens: inputTokens,
                response_tokens: outputTokens,
                sampling_rate: SAMPLE_RATE
            });
        } catch (dbError) {
            logger.warn(`Failed to save sample metadata: ${dbError.message}`);
        }
    } catch (err) {
        // 静默失败，不影响 API 响应
        logger.debug(`Sample request failed (non-critical): ${err.message}`);
    }
}
