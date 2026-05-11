/**
 * CodeBuddy 配置
 * @module services/codebuddy/config
 */

import {readFileSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';

// 默认上游 URL（旧凭证无 base_url 字段时 fallback 使用）
export const DEFAULT_BASE_URL = process.env.CODEBUDDY_DEFAULT_BASE_URL || (process.env.CODEBUDDY_REGION === 'intl' ? 'https://www.codebuddy.ai' : 'https://copilot.tencent.com');

// 额外企业站 URL 列表（逗号分隔，会追加到管理面板的上游下拉列表中）
export const EXTRA_BASE_URLS = process.env.CODEBUDDY_EXTRA_BASE_URLS
    ? process.env.CODEBUDDY_EXTRA_BASE_URLS.split(',').map(u => u.trim()).filter(Boolean)
    : [];

/**
 * 获取 CodeBuddy 基础 URL
 * @param {string} [baseUrl] - 可选，优先使用传入值
 * @returns {string}
 */
export function getCodebuddyBaseUrl(baseUrl) {
    return baseUrl || DEFAULT_BASE_URL;
}

// 凭证目录
export const CODEBUDDY_CREDS_DIR = process.env.CODEBUDDY_CREDS_DIR || '.codebuddy';

// 可用模型列表
export const CODEBUDDY_MODELS = [
    {id: 'glm-5.1', name: 'GLM 5.1', vendor: 'zhipu'},
    {id: 'glm-5.0', name: 'GLM 5.0', vendor: 'zhipu'},
    {id: 'glm-4.7', name: 'GLM 4.7', vendor: 'zhipu'},
    {id: 'glm-4.6v', name: 'GLM 4.6V', vendor: 'zhipu'},
    {id: 'kimi-k2.5', name: 'Kimi K2.5', vendor: 'moonshot'},
    {id: 'minimax-m2.5', name: 'MiniMax M2.5', vendor: 'minimax'},
    {id: 'deepseek-v3-2-volc', name: 'DeepSeek V3.2', vendor: 'deepseek'}
];

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

// 个人版官方域名 — 这些域名不需要传企业头
const PERSONAL_HOSTS = new Set([
    'copilot.tencent.com',
    'www.codebuddy.ai'
]);

/**
 * 判断上游域名是否为个人版
 * @param {string} host - 域名（不含端口和协议）
 * @returns {boolean} true = 个人版
 */
export function isPersonalHost(host) {
    return PERSONAL_HOSTS.has(host);
}

/**
 * 生成 CodeBuddy 请求头
 * 根据上游域名自动区分个人版/企业版：
 * - 个人版（copilot.tencent.com / www.codebuddy.ai）：只传基础头，X-Product = "SaaS"
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
        'X-User-Id': userId
    };

    // 企业版额外头部
    // 官方拦截器逻辑：有 enterpriseId 就注入 X-Enterprise-Id / X-Tenant-Id / X-Department-Info
    // X-Tenant-Id 只要有 enterpriseId 就会注入（无 X-No- 抑制机制）
    if (!personal) {
        if (enterpriseId) {
            headers['X-Enterprise-Id'] = enterpriseId;
            headers['X-Tenant-Id'] = enterpriseId;
        } else {
            logger.warn(`企业版域名 ${host} 缺少 enterpriseId，可能导致请求失败或泄露敏感信息`);
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
