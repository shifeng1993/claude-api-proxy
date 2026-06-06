/**
 * 敏感信息过滤器
 * 对请求/响应内容中的敏感信息进行脱敏处理，并限制字段大小防止磁盘占满
 * @module services/coach/sanitizer
 */

import {MAX_SAMPLE_FIELD_SIZE} from './config.js';

const DEFAULT_PATTERNS = [
    // API Key 格式
    {pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[API_KEY_REDACTED]'},
    // 邮箱
    {pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL_REDACTED]'},
    // 手机号（中国）
    {pattern: /1[3-9]\d{9}/g, replacement: '[PHONE_REDACTED]'},
    // IP 地址
    {pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP_REDACTED]'}
];

/**
 * 对字符串应用所有脱敏规则
 * @param {string} str
 * @param {Array<{pattern: RegExp, replacement: string}>} patterns
 * @returns {string}
 */
function sanitizeString(str, patterns) {
    let result = str;
    for (const {pattern, replacement} of patterns) {
        result = result.replace(pattern, replacement);
    }
    // 超长字符串截断，防止大文件撑爆磁盘
    if (Buffer.byteLength(result, 'utf8') > MAX_SAMPLE_FIELD_SIZE) {
        result = result.substring(0, MAX_SAMPLE_FIELD_SIZE);
        result += '\n...[CONTENT_TRUNCATED]';
    }
    return result;
}

/**
 * 递归脱敏对象/数组中的字符串字段
 * @param {any} obj
 * @param {Array<{pattern: RegExp, replacement: string}>} patterns
 * @returns {any}
 */
function sanitizeValue(obj, patterns) {
    if (typeof obj === 'string') {
        return sanitizeString(obj, patterns);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeValue(item, patterns));
    }
    if (obj !== null && typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = sanitizeValue(value, patterns);
        }
        return result;
    }
    return obj;
}

/**
 * 加载自定义脱敏规则（从环境变量）
 * 格式: COACH_SANITIZE_PATTERNS=pattern1|||replacement1;;;pattern2|||replacement2
 * @returns {Array<{pattern: RegExp, replacement: string}>}
 */
function loadCustomPatterns() {
    const env = process.env.COACH_SANITIZE_PATTERNS;
    if (!env) return [];
    const patterns = [];
    for (const part of env.split(';;;')) {
        const [patternStr, replacement] = part.split('|||');
        if (patternStr && replacement) {
            try {
                // 正则字符串格式: /pattern/flags
                const match = patternStr.match(/^\/(.+)\/([gimsuy]*)$/);
                if (match) {
                    patterns.push({pattern: new RegExp(match[1], match[2] || 'g'), replacement});
                }
            } catch {
                // 忽略无效规则
            }
        }
    }
    return patterns;
}

/**
 * 脱敏处理入口
 * @param {object} data - 要脱敏的数据对象
 * @returns {object} - 脱敏后的数据副本
 */
export function sanitize(data) {
    const patterns = [...DEFAULT_PATTERNS, ...loadCustomPatterns()];
    return sanitizeValue(data, patterns);
}