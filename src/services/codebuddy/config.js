/**
 * CodeBuddy 配置
 * @module services/codebuddy/config
 */

import {readFileSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';

// 默认上游 URL（支持区域切换：cn/intl 对应不同默认上游）
export const DEFAULT_BASE_URL = ''; // 占位，实际值通过 getCodebuddyBaseUrl() 获取
const DEFAULT_CUSTOM_SITE_LABEL = '\u81ea\u5b9a\u4e49\u7ad9';
const LEGACY_CODEBUDDY_PERSONAL_HOST = 'copilot.tencent.com';
const LEGACY_CODEBUDDY_QQ_SUFFIX = '.copilot.qq.com';

// 额外 CodeBuddy 上游 URL 列表（逗号分隔，会追加到管理面板的上游下拉列表中）
// 延迟读取环境变量，因为 ESM import 在 .env 加载前执行
export function getExtraBaseUrls() {
    return process.env.CODEBUDDY_EXTRA_BASE_URLS
        ? process.env.CODEBUDDY_EXTRA_BASE_URLS.split(',')
              .map((u) => u.trim())
              .filter(Boolean)
        : [];
}

// 禁止使用的上游域名（这些域名已废弃，不可再添加新凭证）
export const BLOCKED_DOMAINS = [];

/**
 * 获取 CodeBuddy 基础 URL
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getCodebuddyBaseUrl(baseUrl) {
    if (baseUrl) return baseUrl;
    return (
        process.env.CODEBUDDY_DEFAULT_BASE_URL ||
        (process.env.CODEBUDDY_REGION === 'intl' ? 'https://www.codebuddy.ai' : `https://${LEGACY_CODEBUDDY_PERSONAL_HOST}`)
    );
}

// 自定义/组织上游可用模型
const ENTERPRISE_MODELS = [
    {id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', tools: true, vision: true},
    {id: 'glm-5.1', name: 'GLM-5.1', tools: true, vision: false},
    {id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', tools: true, vision: false},
    {id: 'glm-4.7', name: 'GLM-4.7', tools: true, vision: false},
    {id: 'minimax-m2.7', name: 'MiniMax M2.7', tools: true, vision: false},
    {id: 'kimi-k2.6', name: 'Kimi K2.6', tools: true, vision: true},
    {id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tools: true, vision: false},
    {id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tools: true, vision: false},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek V3.2', tools: true, vision: false}
];

// 国内站可用模型
const PERSONAL_MODELS = [
    {id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', tools: true, vision: true},
    {id: 'glm-5.1', name: 'GLM-5.1', tools: true, vision: false},
    {id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', tools: true, vision: false},
    {id: 'glm-4.6', name: 'GLM-4.6', tools: true, vision: false},
    {id: 'kimi-k2.6', name: 'Kimi K2.6', tools: true, vision: true},
    {id: 'kimi-k2.5', name: 'Kimi K2.5', tools: true, vision: true},
    {id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tools: true, vision: false},
    {id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tools: true, vision: false},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek V3.2', tools: true, vision: false}
];

function normalizeOverrideHost(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    try {
        return new URL(input).host;
    } catch {
        return input;
    }
}

function modelCapability(model, keys, fallback) {
    for (const key of keys) {
        if (model[key] !== undefined) return Boolean(model[key]);
    }
    return fallback;
}

export function getCodebuddyCustomSiteLabels() {
    const raw = process.env.CODEBUDDY_CUSTOM_SITE_LABELS;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return Object.fromEntries(Object.entries(parsed || {})
            .map(([host, label]) => [normalizeOverrideHost(host), String(label || '').trim()])
            .filter(([host, label]) => host && label));
    } catch (error) {
        logger.warn(`Invalid CODEBUDDY_CUSTOM_SITE_LABELS JSON: ${error.message}`);
        return {};
    }
}

export function getCodebuddyCustomSiteLabel(baseUrl) {
    const labels = getCodebuddyCustomSiteLabels();
    const host = normalizeOverrideHost(baseUrl || getCodebuddyBaseUrl());
    return labels[host] || DEFAULT_CUSTOM_SITE_LABEL;
}

export function getHostModelOverrides() {
    const raw = process.env.CODEBUDDY_MODEL_OVERRIDES;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {}).map(([host, models]) => {
            const normalizedHost = normalizeOverrideHost(host);
            const normalizedModels = Array.isArray(models)
                ? models
                    .map(model => ({
                        id: String(model.id || '').trim(),
                        name: String(model.name || model.id || '').trim(),
                        tools: modelCapability(model, ['tools', 'tool', 'supportsTools', 'supports_tool'], true),
                        vision: modelCapability(model, ['vision', 'supportsVision', 'supports_vision'], false)
                    }))
                    .filter(model => model.id)
                : [];
            return [normalizedHost, normalizedModels];
        }).filter(([host, models]) => host && models.length);
        return Object.fromEntries(entries);
    } catch (error) {
        logger.warn(`Invalid CODEBUDDY_MODEL_OVERRIDES JSON: ${error.message}`);
        return {};
    }
}

/**
 * 根据上游域名获取可用模型列表
 * 优先级：特定站点覆盖 > 个人/企业分类
 * @param {string} [baseUrl] - 上游基础 URL
 * @returns {Array<{id: string, name: string, tools: boolean, vision: boolean}>}
 */
export function getModelsForHost(baseUrl) {
    const resolved = getCodebuddyBaseUrl(baseUrl);
    const host = new URL(resolved).host;

    const hostModelOverrides = getHostModelOverrides();
    if (hostModelOverrides[host]) {
        return hostModelOverrides[host];
    }

    return isPersonalHost(host) ? PERSONAL_MODELS : ENTERPRISE_MODELS;
}

// 个人版官方域名 — 这些域名不需要传企业头
const PERSONAL_HOSTS = [LEGACY_CODEBUDDY_PERSONAL_HOST, 'www.codebuddy.ai'];

/**
 * 判断上游域名是否为个人版
 * @param {string} host - 域名（不含端口和协议）
 * @returns {boolean} true = 个人版
 */
export function isPersonalHost(host) {
    return PERSONAL_HOSTS.includes(host);
}

// CodeBuddy 域名特征 — 用于判断某上游是否指向 codebuddy 后端
// 个人站：www.codebuddy.ai
// 企业站：enterprise hosts
const CODEBUDDY_HOST_PATTERNS = [
    LEGACY_CODEBUDDY_PERSONAL_HOST,
    'www.codebuddy.ai',
    'codebuddy.ai'
];

/**
 * 判断某域名是否为 codebuddy 后端域名（含个人站与企业站）
 * @param {string} host - 域名（不含端口和协议）
 * @returns {boolean}
 */
export function isCodebuddyHost(host) {
    if (!host) return false;
    if (CODEBUDDY_HOST_PATTERNS.includes(host)) return true;
    return host.endsWith(LEGACY_CODEBUDDY_QQ_SUFFIX) || host.endsWith('.codebuddy.ai');
}

/**
 * 规范化架构名称（与 CLI OpenAI SDK 逻辑一致）
 * x64 -> amd64, arm -> arm32, ppc -> ppc32
 */
function normalizeArch(arch) {
    if (arch === 'x64') return 'amd64';
    if (arch === 'arm') return 'arm32';
    if (arch === 'ppc') return 'ppc32';
    return arch;
}

/**
 * 规范化平台名称（与 CLI OpenAI SDK 逻辑一致）
 * win32 -> windows, sunos -> solaris
 */
function normalizePlatform(platform) {
    if (platform === 'win32') return 'windows';
    if (platform === 'sunos') return 'solaris';
    return platform;
}

/**
 * 检测运行时类型
 */
function detectRuntime() {
    if (typeof Deno !== 'undefined') return 'deno';
    if (typeof EdgeRuntime !== 'undefined') return 'edge';
    if (typeof process !== 'undefined' && process.release?.name === 'node') return 'node';
    return 'unknown';
}

// CodeBuddy CLI 版本号（用于 User-Agent 和 X-IDE-Version）
// 优先从环境变量读取，否则尝试从本地安装的 CodeBuddy CLI 获取
const CODEBUDDY_CLI_VERSION = (() => {
    try {
        const pkg = JSON.parse(
            readFileSync(join(process.cwd(), 'node_modules/@tencent-ai/codebuddy-code/package.json'), 'utf8')
        );
        if (pkg.version) return pkg.version;
    } catch {
        /* ignore */
    }
    return '2.93.1';
})();

// OpenAI SDK 版本号（从 CodeBuddy CLI 依赖中读取）
const OPENAI_SDK_VERSION = (() => {
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'node_modules/openai/package.json'), 'utf8'));
        if (pkg.version) return pkg.version;
    } catch {
        /* ignore */
    }
    return '6.25.0';
})();

/**
 * 生成 CodeBuddy 请求头
 * 根据上游域名自动区分个人版/企业版：
 * - 个人版（www.codebuddy.ai）：只传基础头，X-Product = "SaaS"
 * - 企业版（其他域名）：额外传 X-Enterprise-Id / X-Tenant-Id / X-Department-Info
 *
 * @param {string} bearerToken - Bearer token
 * @param {Object} options - 可选参数
 * @param {string} [options.baseUrl] - 上游基础 URL
 * @param {string} [options.userId] - 用户 ID
 * @param {string} [options.enterpriseId] - 企业 ID（企业版需要）
 * @param {string} [options.departmentInfo] - 部门全称（企业版需要）
 * @param {string} [options.domain] - 认证域（企业版需要）
 * @returns {Object} 请求头
 */
export function codebuddyHeaders(bearerToken, options = {}) {
    const {
        conversationId,
        conversationRequestId,
        conversationMessageId,
        requestId,
        userId = process.env.CODEBUDDY_DEFAULT_USER_ID || 'unknown',
        enterpriseId,
        departmentInfo,
        domain,
        baseUrl
    } = options;

    const resolvedBaseUrl = getCodebuddyBaseUrl(baseUrl);
    const host = new URL(resolvedBaseUrl).host;
    const personal = isPersonalHost(host);

    const headers = {
        Host: host,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'x-stainless-arch': normalizeArch(process.arch ?? 'unknown'),
        'x-stainless-lang': 'js',
        'x-stainless-os': normalizePlatform(process.platform ?? 'unknown'),
        'x-stainless-package-version': OPENAI_SDK_VERSION,
        'x-stainless-retry-count': '0',
        'x-stainless-runtime': detectRuntime(),
        'x-stainless-runtime-version': process.version ?? 'unknown',
        'X-Agent-Intent': 'craft',
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'CLI',
        'X-IDE-Version': CODEBUDDY_CLI_VERSION,
        Authorization: `Bearer ${bearerToken}`,
        'X-Domain': domain || host,
        'User-Agent': `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
        'X-Product': 'SaaS',
        'X-User-Id': userId,
        // 腾讯云文档要求：X-Session-ID 将同一用户的连续请求路由到同一推理实例，
        // 提高该实例上的 KV Cache 局部命中率，与 prompt_cache_key 配合使用效果更佳
        'X-Session-ID': userId || 'unknown'
    };

    // 企业版额外头部
    if (!personal) {
        if (enterpriseId) {
            headers['X-Enterprise-Id'] = enterpriseId;
            headers['X-Tenant-Id'] = enterpriseId;
        }
        if (departmentInfo) {
            headers['X-Department-Info'] = departmentInfo;
        }
    }

    if (conversationId) {
        headers['X-Conversation-ID'] = conversationId;
    }
    if (conversationRequestId) {
        headers['X-Conversation-Request-ID'] = conversationRequestId;
    }
    if (conversationMessageId) {
        headers['X-Conversation-Message-ID'] = conversationMessageId;
    }
    if (requestId) {
        headers['X-Request-ID'] = requestId;
    }

    return headers;
}

/**
 * 获取 CodeBuddy API URL
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getCodebuddyApiUrl(baseUrl) {
    const resolved = getCodebuddyBaseUrl(baseUrl);
    return `${resolved}/v2/chat/completions`;
}
