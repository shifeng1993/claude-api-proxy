/**
 * 重试配置常量
 * 参考 Claude Code 源码 withRetry.ts
 */

// 基础重试配置
export const RETRY_CONFIG = {
    // 最大重试次数
    MAX_RETRIES: 10,

    // 基础延迟（毫秒）
    BASE_DELAY_MS: 500,

    // 最大延迟上限（毫秒）
    MAX_DELAY_MS: 30000,

    // 总重试时间预算（毫秒）- 10分钟后放弃
    GIVE_UP_MS: 600000,

    // 抖动百分比（±25%防止惊群效应）
    JITTER_PERCENT: 0.25,

    // 529过载错误最大重试次数
    MAX_529_RETRIES: 3,

    // 短重试阈值（小于此值不进入冷却）
    SHORT_RETRY_THRESHOLD_MS: 20000,

    // 限流冷却最小时间（毫秒）
    MIN_COOLDOWN_MS: 600000,
};

// HTTP状态码分类
export const HTTP_STATUS = {
    // 需要重试的状态码
    RETRYABLE: new Set([408, 429, 500, 502, 503, 504, 529]),

    // 永久错误（不重试）
    PERMANENT: new Set([400, 401, 403, 404]),

    // 认证错误（需刷新凭证后重试一次）
    AUTH: new Set([401]),
};

// 网络错误码（可重试）
export const RETRYABLE_ERRORS = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EHOSTUNREACH',
]);

export default RETRY_CONFIG;