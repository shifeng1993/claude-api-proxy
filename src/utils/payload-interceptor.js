/**
 * Payload 拦截器
 * 在最终发送给上游 API 之前，拦截并保存序列化后的 payload 到文件
 * 用于对比 relay/codebuddy 两个通道的隐式缓存命中差异
 *
 * 通过环境变量控制：
 * - PAYLOAD_INTERCEPT_ENABLED=true  启用拦截（默认关闭）
 * - PAYLOAD_INTERCEPT_DIR           保存目录（默认 .debug-payloads）
 * - PAYLOAD_INTERCEPT_MAX_FILES     每个通道最多保留文件数（默认 500）
 * - PAYLOAD_INTERCEPT_PREFIX_CHARS  前缀 hash 字符数（默认 3000）
 *
 * 目录结构：{baseDir}/{channel}/{timestamp}_{model}_{tenant}.json
 * 文件命名：{timestamp}_{model}_{tenant}.json
 * @module utils/payload-interceptor
 */

import {writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync} from 'fs';
import {join} from 'path';
import {createHash} from 'crypto';
import logger from './logger.js';

const DEFAULT_DIR = '.debug-payloads';
const DEFAULT_MAX_FILES = 500;
const DEFAULT_PREFIX_CHARS = 3000;
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization', 'x-session-id']);

let configCache = null;
let debugFileSequence = 0;

function parsePositiveInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig() {
    if (configCache) return configCache;
    configCache = {
        enabled: process.env.PAYLOAD_INTERCEPT_ENABLED === 'true',
        baseDir: process.env.PAYLOAD_INTERCEPT_DIR || DEFAULT_DIR,
        maxFiles: parsePositiveInt(process.env.PAYLOAD_INTERCEPT_MAX_FILES || String(DEFAULT_MAX_FILES), DEFAULT_MAX_FILES),
        prefixChars: parsePositiveInt(process.env.PAYLOAD_INTERCEPT_PREFIX_CHARS || String(DEFAULT_PREFIX_CHARS), DEFAULT_PREFIX_CHARS)
    };
    return configCache;
}

/**
 * 重置 config 缓存，确保环境变量变化时重新读取
 */
export function resetInterceptorConfig() {
    configCache = null;
}

/**
 * 确保目录存在
 */
function ensureDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, {recursive: true});
    }
}

/**
 * 清理超出数量限制的旧文件，保留最新的 maxFiles 个
 */
function cleanupOldFiles(dir, maxFiles) {
    try {
        if (!existsSync(dir)) return;
        const files = readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
                const filePath = join(dir, f);
                const stat = statSync(filePath);
                return {name: f, path: filePath, mtime: stat.mtimeMs};
            })
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length <= maxFiles) return;

        const toDelete = files.slice(maxFiles);
        for (const file of toDelete) {
            try {
                unlinkSync(file.path);
            } catch (e) {
                // 删除失败不阻塞
            }
        }
    } catch (e) {
        // 清理失败不阻塞业务
    }
}

/**
 * 生成安全的文件名
 */
function sanitizeFilename(str) {
    if (!str) return 'unknown';
    return String(str).replace(/[^a-zA-Z0-9一-龥._-]/g, '_').slice(0, 80);
}

function nextDebugSequence() {
    debugFileSequence = (debugFileSequence + 1) % 1000000;
    return String(debugFileSequence).padStart(6, '0');
}

function sanitizeHeaders(headers = {}) {
    const sanitized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        sanitized[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
    return sanitized;
}

function buildPrefixHash(serializedPayload, prefixChars) {
    const prefix = serializedPayload.substring(0, prefixChars);
    return {
        hash: createHash('sha256').update(prefix).digest('hex').slice(0, 16),
        length: prefix.length
    };
}

function writeDebugRecord(targetDir, filename, record, maxFiles) {
    ensureDir(targetDir);
    writeFileSync(join(targetDir, filename), JSON.stringify(record, null, 2), 'utf8');
    setImmediate(() => cleanupOldFiles(targetDir, maxFiles));
}

function sanitizeMetaValue(value) {
    if (typeof value !== 'string' || !value) return value;
    // 对会话 key 做脱敏：只保留前 8 字符 + 哈希短摘要
    const prefix = value.slice(0, 8);
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
    return `${prefix}...${hash}`;
}

/**
 * 拦截并保存 payload
 *
 * @param {object} payload - 最终的请求体（已序列化前的对象）
 * @param {object} meta - 元信息
 * @param {string} meta.channel - 通道标识: 'relay' | 'codebuddy'
 * @param {string} meta.model - 模型名
 * @param {string} [meta.tenantName] - 租户名
 * @param {string} [meta.tenantUsername] - 租户用户名
 * @param {string} [meta.upstream] - 上游名称/URL
 * @param {string} [meta.endpoint] - API 端点路径
 * @param {boolean} [meta.stream] - 是否流式
 * @param {object} [meta.headers] - 最终上游请求头
 * @param {string} [meta.conversationKey] - 对话锚点 key
 * @param {string} [meta.promptCacheKey] - prompt_cache_key
 * @returns {object} 原样返回 payload（不修改）
 */
export function interceptPayload(payload, meta = {}) {
    const config = loadConfig();
    if (!config.enabled) return payload;

    try {
        const channel = meta.channel || 'unknown';
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const modelPart = sanitizeFilename(meta.model || payload?.model || 'unknown');
        const tenantPart = meta.tenantName
            ? sanitizeFilename(`${meta.tenantName}_${meta.tenantUsername || ''}`)
            : 'no-tenant';
        const serializedPayload = JSON.stringify(payload);
        const {hash: prefixHash, length: prefixLength} = buildPrefixHash(serializedPayload, config.prefixChars);

        const filename = `${timestamp}_${nextDebugSequence()}_${modelPart}_${tenantPart}.json`;
        const record = {
            _meta: {
                channel,
                timestamp: now.toISOString(),
                model: meta.model || payload?.model || 'unknown',
                tenantName: meta.tenantName || null,
                tenantUsername: meta.tenantUsername || null,
                upstream: meta.upstream || null,
                endpoint: meta.endpoint || null,
                stream: meta.stream !== undefined ? meta.stream : null,
                headers: sanitizeHeaders(meta.headers),
                conversationKey: sanitizeMetaValue(meta.conversationKey) || null,
                promptCacheKey: sanitizeMetaValue(meta.promptCacheKey || payload?.prompt_cache_key) || null,
                prefixHash,
                prefixLength,
                payloadSize: serializedPayload.length,
                messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
                toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0
            },
            payload
        };
        writeDebugRecord(join(config.baseDir, channel), filename, record, config.maxFiles);
        logger.debug(`[PayloadInterceptor] ${channel}: saved ${filename}`);
    } catch (e) {
        // 拦截失败不阻塞业务
        logger.warn(`[PayloadInterceptor] failed to save: ${e.message}`);
    }

    return payload;
}

/**
 * 拦截并 JSON 序列化 payload
 * 便捷方法：拦截 + JSON.stringify 一体，替换原有的 JSON.stringify(normalizePayload(...))
 *
 * @param {object} payload - 最终的请求体
 * @param {object} meta - 元信息（同 interceptPayload）
 * @returns {string} JSON 序列化后的字符串
 */
export function interceptAndSerialize(payload, meta = {}) {
    interceptPayload(payload, meta);
    return JSON.stringify(payload);
}
