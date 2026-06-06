/**
 * Coach 模块配置
 * @module services/coach/config
 */

// 分析用的 API base URL（走 relay）
export const COACH_API_BASE = process.env.COACH_API_BASE || 'http://127.0.0.1:3080/relay';

// 分析用的 API Key
export const COACH_API_KEY = process.env.COACH_API_KEY || '';

// 分析用的模型
export const COACH_MODEL = process.env.COACH_MODEL || 'glm-5';

// 最少采样数（低于此值不触发分析）
export const COACH_MIN_SAMPLES = 5;

// 每次分析最大采样数（放入 prompt 的样本数）
export const MAX_SAMPLES_IN_PROMPT = 50;

// 单条内容最大长度（字符）
export const MAX_CONTENT_LENGTH = 2000;

// 分析 API 超时（毫秒）
export const ANALYSIS_TIMEOUT_MS = 120_000;

// 重试次数
export const RETRY_COUNT = 3;

// 重试间隔（毫秒）
export const RETRY_DELAY_MS = 30_000;

// 单个样本字段最大字节数（防止超大请求/响应撑爆磁盘）
export const MAX_SAMPLE_FIELD_SIZE = 50 * 1024;
