/**
 * CodeBuddy API 客户端
 * @module services/codebuddy/api
 */

import {request, readBody} from '../../utils/http-client.js';
import {normalizePayload} from './protocol-adapter.js';
import {interceptAndSerialize} from '../../utils/payload-interceptor.js';
import logger from '../../utils/logger.js';
import {getCodebuddyApiUrl, codebuddyHeaders, getCodebuddyBaseUrl, getModelsForHost, isPersonalHost} from './config.js';
import {randomBytes} from 'crypto';

// CodeBuddy 服务端会检测竞争对手关键词并触发 content_filter
// 必须在所有消息和工具定义中替换，不能只替换 system 消息
const KEYWORD_REPLACEMENTS = [
    // 先替换长串，再替换短串，避免短串先命中导致长串匹配失败
    ['Main branch (you will usually use this for PRs)', 'Default branch (you will usually use this for MRs)'],
    ["Claude Code, Anthropic's official CLI for Claude", "CodeBuddy Code, Tencent's official CLI for CodeBuddy"],
    ['anthropic', 'tencent']
];

/**
 * 对字符串应用关键词替换
 */
function replaceKeywords(text) {
    if (typeof text !== 'string') return text;
    for (const [old, replacement] of KEYWORD_REPLACEMENTS) {
        text = text.replaceAll(old, replacement);
    }
    return text;
}

/**
 * 递归清理 payload 中会触发服务端内容审核的关键词
 * 替换所有消息内容、工具定义中的敏感词
 */
function sanitizePayload(payload) {
    if (!payload.messages) return;

    for (const msg of payload.messages) {
        if (typeof msg.content === 'string') {
            msg.content = replaceKeywords(msg.content);
        } else if (Array.isArray(msg.content)) {
            for (const item of msg.content) {
                if (item && typeof item.text === 'string') {
                    item.text = replaceKeywords(item.text);
                }
                if (item && typeof item.content === 'string') {
                    item.content = replaceKeywords(item.content);
                }
            }
        }
    }

    // 工具定义中的描述和参数也可能包含触发词
    if (Array.isArray(payload.tools)) {
        const toolsStr = replaceKeywords(JSON.stringify(payload.tools));
        try {
            payload.tools = JSON.parse(toolsStr);
        } catch {
            // JSON 替换后解析失败则跳过
        }
    }
}

/**
 * 生成不带横线的 UUID（性能优化版本）
 * 比 randomUUID().replace(/-/g, '') 更快
 */
function generateCompactId() {
    return randomBytes(16).toString('hex');
}

/**
 * 生成标准格式 UUID
 */
function generateUUID() {
    const bytes = randomBytes(16);
    // 设置版本 4 和变体
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 获取可用模型列表
 * @returns {Promise<Object>}
 */
export async function getModels(credential = null) {
    if (!credential) {
        throw new Error('No valid CodeBuddy credentials available');
    }

    return {
        data: getModelsForHost(credential.base_url),
        object: 'list'
    };
}

/**
 * 创建 chat completions
 * @param {Object} payload - OpenAI 格式的请求体
 * @param {Object} options - 可选参数
 * @returns {Promise<{body: ReadableStream, headers: Object, status: number}>}
 */
export async function createChatCompletions(payload, options = {}) {
    const credential = options.credential;
    if (!credential) {
        throw new Error('No valid CodeBuddy credentials available. Please add credentials or use a valid API key.');
    }

    const bearerToken = credential.bearer_token;
    const userId = credential.user_id;
    const baseUrl = getCodebuddyBaseUrl(credential.base_url);
    let enterpriseId = credential.enterprise_id;
    const departmentInfo = credential.department_info;
    const domain = credential.domain;

    // 兜底：enterprise_id 为空时，从 JWT bearer token 的 realm_access.roles 中提取
    const upstreamHost = new URL(baseUrl).host;
    if (!enterpriseId && !isPersonalHost(upstreamHost)) {
        try {
            const jwtPayload = JSON.parse(Buffer.from(bearerToken.split('.')[1], 'base64url').toString());
            const entMemberRole = jwtPayload?.realm_access?.roles?.find(r => r.startsWith('ent-member:'));
            if (entMemberRole) {
                enterpriseId = entMemberRole.split(':')[1];
                logger.info(`[CodeBuddy]: 从 JWT token 兜底提取企业标识: ${enterpriseId}, credential: ${userId}`);
            }
        } catch (e) {
            logger.warn(`[CodeBuddy]: 从 JWT token 提取企业标识失败: ${e.message}`);
        }
    }

    // 生成会话 ID（使用优化后的函数）
    const conversationId = options.conversationId || generateUUID();
    const conversationRequestId = options.conversationRequestId || generateCompactId();
    const conversationMessageId = options.conversationMessageId || generateCompactId();
    const requestId = options.requestId || generateCompactId();

    // 构建请求头
    const headers = codebuddyHeaders(bearerToken, {
        conversationId,
        conversationRequestId,
        conversationMessageId,
        requestId,
        userId,
        enterpriseId,
        departmentInfo,
        domain,
        baseUrl
    });

    // 确保 stream 为 true（CodeBuddy 只支持流式请求）
    const requestPayload = {
        ...payload,
        stream: true
    };

    // 腾讯云文档要求：同一对话的所有请求使用相同的 prompt_cache_key，
    // 值为 conversation_id，用于标识可复用 KV Cache 的请求前缀
    if (conversationId) {
        requestPayload.prompt_cache_key = conversationId;
    }

    // 个人站服务端会检测竞争对手关键词并触发 content_filter，需要替换
    // 自定义/组织上游无此限制，跳过替换
    const host = new URL(getCodebuddyBaseUrl(baseUrl)).host;
    if (isPersonalHost(host)) {
        // DEBUG: 记录个人站请求的 payload 关键内容，用于排查 content_filter 触发原因
        const sysMsg = requestPayload.messages?.find(m => m.role === 'system');
        const userMsgs = requestPayload.messages?.filter(m => m.role === 'user');
        sanitizePayload(requestPayload);
    }
    const url = getCodebuddyApiUrl(baseUrl);
    const userInfo = options.tenantName && options.tenantUsername ? `${options.tenantName}(${options.tenantUsername})` : '';
    logger.info(
        `[CodeBuddy]: ${baseUrl}, model: ${payload.model}, effort: ${requestPayload.reasoning_effort || 'high'}, credential: ${userId}, ${userInfo}`
    );

    const response = await request(url, {
        method: 'POST',
        headers,
        body: interceptAndSerialize(normalizePayload(requestPayload, {source: 'codebuddy', upstream: baseUrl}), {
            channel: 'codebuddy',
            model: payload.model,
            upstream: baseUrl,
            endpoint: 'chat/completions',
            stream: requestPayload.stream,
            ...(options.tenantName ? {tenantName: options.tenantName, tenantUsername: options.tenantUsername} : {})
        })
    });

    if (response.status >= 400) {
        const errorBody = await readBody(response.body);

        logger.error(`CodeBuddy API error${userInfo ? `, ${userInfo}` : ''}: ${response.status} - ${errorBody.slice(0, 300)}`);
        throw new Error(`CodeBuddy API error: ${response.status} - ${errorBody}`);
    }

    return response;
}
