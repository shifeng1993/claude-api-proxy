/**
 * 公共 Translator 逻辑
 * 抽取自 CodeBuddy/Relay translator 的重复代码
 * @module transformer/shared-translator
 */

import {randomBytes, createHash} from 'crypto';
import logger from '../utils/logger.js';
import {getBehaviorRules} from '../config/system-prompts.js';

/**
 * 从 OpenAI 格式 usage 中提取缓存命中 token 数
 * DeepSeek: prompt_cache_hit_tokens
 * OpenAI: prompt_tokens_details.cached_tokens
 */
export function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_cache_hit_tokens) return usage.prompt_cache_hit_tokens;
    if (usage.prompt_tokens_details?.cached_tokens) return usage.prompt_tokens_details.cached_tokens;
    return 0;
}

/**
 * 生成唯一 ID
 */
export function generateId() {
    return randomBytes(16).toString('hex');
}

/**
 * 映射 OpenAI stop reason 到 Anthropic 格式
 */
export function mapStopReason(finishReason) {
    const mapping = {
        stop: 'end_turn',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'end_turn'
    };
    return mapping[finishReason] || null;
}

/**
 * 转换 tool_choice
 */
export function translateToolChoice(anthropicToolChoice) {
    if (!anthropicToolChoice) {
        return undefined;
    }

    if (anthropicToolChoice.type === 'auto') {
        return 'auto';
    }
    if (anthropicToolChoice.type === 'any') {
        return 'required';
    }
    if (anthropicToolChoice.type === 'tool') {
        return {
            type: 'function',
            function: {name: anthropicToolChoice.name}
        };
    }

    return undefined;
}

export function normalizeClaudeModelAlias(model) {
    return model;
}

function sanitizeAnthropicContentBlock(block) {
    if (!block || typeof block !== 'object') return block;

    if (block.type === 'thinking') {
        const clean = {type: 'thinking'};
        if (typeof block.thinking === 'string') clean.thinking = block.thinking;
        if (typeof block.signature === 'string') clean.signature = block.signature;
        return clean;
    }

    if (block.type === 'redacted_thinking') {
        const clean = {type: 'redacted_thinking'};
        if (typeof block.data === 'string') clean.data = block.data;
        return clean;
    }

    return block;
}

export function sanitizeAnthropicMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((message) => {
        if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
            return message;
        }
        return {
            ...message,
            content: message.content.map(sanitizeAnthropicContentBlock)
        };
    });
}

export function sanitizeAnthropicPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    return {
        ...payload,
        messages: sanitizeAnthropicMessages(payload.messages)
    };
}

export function extractReasoningFromDelta(delta) {
    if (!delta || typeof delta !== 'object') return null;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        return {text: delta.reasoning_content};
    }
    if (typeof delta.thinking === 'string' && delta.thinking) {
        return {text: delta.thinking};
    }
    if (delta.thinking && typeof delta.thinking === 'object') {
        const text = delta.thinking.content || '';
        if (text) return {text, signature: delta.thinking.signature || undefined};
    }
    if (typeof delta.thought === 'string' && delta.thought) return {text: delta.thought};
    if (typeof delta.reasoning === 'string' && delta.reasoning) return {text: delta.reasoning};

    if (typeof delta.content === 'string' && delta.content.includes('<think>')) {
        const start = delta.content.indexOf('<think>');
        const before = delta.content.slice(0, start);
        const afterOpen = delta.content.slice(start + '<think>'.length);
        const closeIndex = afterOpen.indexOf('</think>');
        if (closeIndex >= 0) {
            return {
                text: afterOpen.slice(0, closeIndex),
                remainingContent: before + afterOpen.slice(closeIndex + '</think>'.length)
            };
        }
        return {text: afterOpen, remainingContent: before, thinkOpen: true};
    }
    return null;
}

/**
 * 将 base64 编码的文档内容解码为文本
 * 支持 PDF、纯文本、代码文件等
 */
function decodeDocumentToText(block) {
    const source = block.source;
    if (!source || source.type !== 'base64' || !source.data) {
        return null;
    }

    const mediaType = (source.media_type || '').toLowerCase();

    // 纯文本类文件：直接 base64 解码
    const textMediaTypes = [
        'text/plain',
        'text/markdown',
        'text/csv',
        'text/html',
        'text/xml',
        'text/css',
        'text/javascript',
        'text/x-python',
        'text/x-java',
        'text/x-c',
        'text/x-cpp',
        'text/x-shellscript',
        'text/x-yaml',
        'text/x-json',
        'text/x-toml',
        'text/x-rust',
        'application/json',
        'application/xml',
        'application/javascript',
        'application/x-yaml',
        'application/x-sh'
    ];
    if (textMediaTypes.includes(mediaType)) {
        try {
            return Buffer.from(source.data, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }

    // PDF: 尝试提取文本，失败则回退为 base64 image_url
    if (mediaType === 'application/pdf') {
        try {
            const pdfBuffer = Buffer.from(source.data, 'base64');
            const text = extractPDFText(pdfBuffer);
            if (text && text.trim().length > 0) {
                return text;
            }
        } catch {
            // PDF 文本提取失败，回退
        }
        // 无法提取文本，将 PDF 作为 base64 data URL 传递
        return null;
    }

    // 未知类型：尝试 base64 解码为文本
    try {
        const decoded = Buffer.from(source.data, 'base64').toString('utf8');
        // 简单判断是否包含大量不可打印字符（二进制文件）
        const nonPrintable = decoded.split('').filter((c) => {
            const code = c.charCodeAt(0);
            return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
        }).length;
        if (nonPrintable / decoded.length < 0.1) {
            return decoded;
        }
    } catch {}

    return null;
}

/**
 * 从 PDF Buffer 中提取纯文本
 * 使用简单的正则匹配方式，无需外部依赖
 */
function extractPDFText(buffer) {
    const text = buffer.toString('latin1');

    // 提取括号内文本对象 (PDF 文本对象格式: (text) Tj 或 [(text1)(text2)] TJ)
    const texts = [];
    const parenRegex = /\(([^\\)]*(?:\\.[^\\)]*)*)\)/g;
    let match;
    while ((match = parenRegex.exec(text)) !== null) {
        const raw = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
        if (raw.trim().length > 0) {
            texts.push(raw);
        }
    }

    return texts.join('\n');
}

/**
 * 映射内容块
 * 支持 text、image、document（PDF/文本文件）类型
 */
export function mapContent(blocks) {
    if (blocks.length === 1 && blocks[0].type === 'text') {
        return blocks[0].text;
    }

    const mapped = blocks
        .map((block) => {
            if (block.type === 'text') {
                return {type: 'text', text: block.text};
            }
            if (block.type === 'image') {
                return {
                    type: 'image_url',
                    image_url: {
                        url:
                            block.source.type === 'base64'
                                ? `data:${block.source.media_type};base64,${block.source.data}`
                                : block.source.url
                    }
                };
            }
            if (block.type === 'document') {
                const extractedText = decodeDocumentToText(block);
                if (extractedText) {
                    return {type: 'text', text: extractedText};
                }
                // 无法提取文本，将文档作为 base64 data URL 传递
                const source = block.source;
                if (source && source.type === 'base64' && source.data) {
                    return {
                        type: 'image_url',
                        image_url: {
                            url: `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`
                        }
                    };
                }
                return null;
            }
            if (block.text) {
                return {type: 'text', text: block.text};
            }
            return null;
        })
        .filter(Boolean);

    if (mapped.length === 0) {
        return '';
    }

    return mapped;
}

/**
 * 透传用户消息内容，不在中间注入任何标记
 * 中文思考规则已完全收敛到 system 前缀中，避免中间注入打断缓存前缀匹配
 */
export function prependThinkingHint(content) {
    return content;
}

/**
 * 透传工具返回结果内容，不在中间注入任何标记
 */
export function prependToolThinkingHint(content) {
    return content;
}

/**
 * 将行为规则注入到 OpenAI 格式的 messages 数组中
 * 如果存在 system 消息则前置，否则新建
 * 不在消息中间插入内容，以保持缓存前缀连续性
 *
 * 缓存优化：
 * 1. 剥离客户端 system 中的动态内容（x-anthropic-billing-header 等），追加到
 *    messages 最后一条 user 消息尾部，避免动态内容破坏 system 前缀一致性
 * 2. 检测客户端 system 是否已包含代理行为规则，避免重复注入
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @returns {Array} 注入后的 messages 数组
 */
export function injectBehaviorRules(messages) {
    const behaviorRules = getBehaviorRules();
    const result = [];

    const systemIndex = messages.findIndex((m) => m.role === 'system');

    if (systemIndex >= 0) {
        const originalSystem = messages[systemIndex].content;
        const systemStr =
            typeof originalSystem === 'string' ? originalSystem : originalSystem.map((p) => p.text ?? '').join('\n');
        // 客户端 system 已包含代理行为规则时跳过注入，避免重复
        const alreadyHasRules = systemStr.includes('<reasoning-rules>');
        // 剥离动态行（如 x-anthropic-billing-header），保持 system 前缀稳定
        // 动态行直接丢弃：它们的值每次请求都变（如 cch=xxx 哈希），
        // 即使追加到 user 消息尾部也会污染 messages 前缀导致缓存 miss
        const stableContent = extractStableContent(systemStr);
        const systemPrefix = alreadyHasRules ? '' : behaviorRules + '\n\n';
        result.push({...messages[systemIndex], content: systemPrefix + stableContent});

        for (let i = 0; i < messages.length; i++) {
            if (i === systemIndex) continue;
            result.push(messages[i]);
        }
    } else {
        result.push({role: 'system', content: behaviorRules});
        for (const m of messages) result.push(m);
    }

    return result;
}

/**
 * 从 system 内容中提取稳定部分，剥离纯记账行
 *
 * 关键发现：所有动态行在序列化 JSON 中都位于 3000 字符前缀之后，
 * 保留原值不影响缓存命中率。因此策略调整为：
 * - 纯记账行：剥离（sessionId、fingerprint、cc_version 等）
 * - 其余动态行（env/git/memory 等）：保留原值
 */
export function extractStableContent(systemContent) {
    // 统一换行符：CRLF → LF，避免不同抓包工具产生不一致的过滤结果
    const normalized = systemContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const stableLines = [];
    let insideProxyTag = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('<proxy:') && trimmed.endsWith('>')) {
            insideProxyTag = true;
            stableLines.push(line);
            continue;
        }
        if (insideProxyTag && trimmed.startsWith('</proxy:')) {
            insideProxyTag = false;
            stableLines.push(line);
            continue;
        }
        if (insideProxyTag) {
            stableLines.push(line);
            continue;
        }
        if (trimmed === '') {
            stableLines.push(line);
            continue;
        }

        // 剥离纯记账行，其余（env/git/memory 等）保留原值
        const result = normalizeDynamicLine(trimmed);
        if (result.action === 'drop') continue;
        stableLines.push(line);
    }

    let result = stableLines.join('\n');

    // 段落去重：harness 可能重复注入相同的提示段落
    // 段落 = 被空行分隔的非空文本块
    // 当检测到重复段落时，意味着 harness 开始重复注入系统提示前缀，
    // 此段落及之后的所有内容都应截断丢弃，避免后续被污染的内容混入
    const parts = result.split(/(\n\n+)/);
    const out = [];
    let pendingSep = '';
    const seen = new Set();
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) {
            const p = parts[i].trimEnd();
            if (!p) { pendingSep = ''; continue; }
            if (seen.has(p)) break;
            seen.add(p);
            if (out.length > 0) out.push(pendingSep);
            out.push(p);
        } else {
            pendingSep = parts[i];
        }
    }
    result = out.join('');

    return result.trimEnd();
}

/**
 * 归一化动态行：保留结构信号，替换动态值为固定占位符
 *
 * 关键发现：所有动态行（env 块、gitStatus 等）在序列化 JSON 中
 * 都位于 3000 字符前缀之后，保留原值不影响缓存命中率。
 * 因此策略调整为：只剥离纯记账/对模型无意义的行，其余保留原值。
 *
 * @param {string} line - 待处理的行（已 trim）
 * @returns {{action: 'keep'|'drop', normalizedLine?: string}}
 */
function normalizeDynamicLine(line) {
    // ── 仍然剥离的行（纯记账/模型不需要）──
    if (/^x-[a-z]/i.test(line)) return {action: 'drop'};
    if (/^sessionId:/i.test(line)) return {action: 'drop'};
    if (/fingerprint[-:][a-f0-9]{6,}/i.test(line)) return {action: 'drop'};
    if (/^cc_version:/i.test(line)) return {action: 'drop'};
    // commit hash 行由 extractStableContent 的 isGitStatusLine 在 git 块上下文中处理，
    // 不在此全局匹配，避免误杀非 git 的十六进制内容（如配置值、ID 等）

    // ── 以下行全在前缀范围外，保留原值不影响缓存 ──
    return {action: 'keep'};
}

/**
 * 判断一行是否应被剥离（纯记账/模型不需要）
 * 所有动态行都在序列化 JSON 的 3000 字符前缀之后，保留原值不影响缓存
 * 因此只剥离纯记账行，env/git/memory 等信息行保留原值
 * @deprecated 新逻辑在 extractStableContent 中直接使用 normalizeDynamicLine
 */
function isDynamicLine(line) {
    // 与 normalizeDynamicLine 的 drop 列表保持一致
    if (/^x-[a-z]/i.test(line)) return true;
    if (/^sessionId:/i.test(line)) return true;
    if (/fingerprint[-:][a-f0-9]{6,}/i.test(line)) return true;
    if (/^cc_version:/i.test(line)) return true;
    // commit hash 不再全局匹配，避免误杀非 git 的十六进制内容
    return false;
}

/**
 * 递归排序对象 key，确保相同内容产生相同的 JSON 序列化
 * 上游 prompt caching 要求请求前缀逐字节一致，嵌套对象 key 顺序不同会导致 miss
 */
export function sortObjectKeys(obj) {
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    if (obj !== null && typeof obj === 'object') {
        const sorted = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortObjectKeys(obj[key]);
        }
        return sorted;
    }
    return obj;
}

function stableAnchorText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(sortObjectKeys(value)) || '';
    } catch {
        return String(value);
    }
}

function hashAnchor(value, limit) {
    return createHash('sha256').update(stableAnchorText(value).slice(0, limit)).digest('hex').slice(0, 16);
}

/**
 * 基于第一条用户消息 + tenantId 生成稳定 cache key。
 * 同一对话多轮只在 messages 尾部追加时，首条 user 和 tenantId 保持不变，
 * 不依赖 system/tools —— 这些在对话过程中可能变化，不应影响 key。
 */
export function buildConversationAnchorKey(payload, meta = {}) {
    if (!payload || typeof payload !== 'object') return undefined;

    const messages = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload.input)
            ? payload.input
            : [];
    const anchors = [];

    const firstUserMsg = messages.find((message) => (message.role || message.type) === 'user');
    if (firstUserMsg) {
        anchors.push('u:' + hashAnchor(firstUserMsg.content, 300));
    }

    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const tenantId = meta.tenantId || payload.tenantId || payload.tenant_id || metadata.tenantId || metadata.tenant_id;
    if (tenantId) {
        anchors.push('tid:' + tenantId);
    }

    if (anchors.length === 0) return undefined;
    return 'conv_' + createHash('sha256').update(anchors.join('|')).digest('hex').slice(0, 24);
}

/**
 * 统一 payload 字段顺序和默认值，确保相同内容产生相同字节序列
 * 上游 prompt caching 要求请求前缀逐字节一致，字段顺序不同会导致缓存 miss
 */
const FIELD_ORDER = [
    'model',
    'messages',
    'stream',
    'max_tokens',
    'temperature',
    'stop',
    'top_p',
    'thinking',
    'metadata',
    'previous_response_id',
    'tools',
    'tool_choice',
    'reasoning_effort'
];

export function normalizePayload(payload, meta = {}) {
    const ordered = {};
    for (const key of FIELD_ORDER) {
        if (payload[key] !== undefined) ordered[key] = payload[key];
    }
    for (const key of Object.keys(payload)) {
        if (!(key in ordered)) ordered[key] = payload[key];
    }

    // 空字符串 '' 表示用户明确关闭 thinking，不注入默认值，也不发送给上游
    if (ordered.reasoning_effort === '') {
        delete ordered.reasoning_effort;
    } else if (ordered.reasoning_effort === undefined) {
        // haiku 系列不支持 reasoning_effort，跳过默认注入
        const m = (ordered.model || '').toLowerCase();
        if (!m.includes('haiku')) {
            ordered.reasoning_effort = 'high';
        }
    }
    if (ordered.stream && !ordered.stream_options) {
        ordered.stream_options = {include_usage: true};
    }

    // tools 排序：递归排序 key + 按 function.name 排序，保证 JSON.stringify 输出稳定
    // messages 不排序：开销大且改变结构会破坏已有缓存兼容性
    if (ordered.tools) {
        ordered.tools = ordered.tools
            .map((t) => sortObjectKeys(t))
            .sort((a, b) => (a.function?.name || '').localeCompare(b.function?.name || ''));
    }

    return ordered;
}

/**
 * 从 messages 中剥离纯记账性质的 <system-reminder> 块，
 * 并归一化会话身份相关的动态内容，保持缓存前缀稳定
 *
 * 参考 claude-code-cache-fix 的 content-strip + identity-normalization + fresh-session-sort 策略
 *
 * 处理以下动态内容（按执行顺序）：
 * 1. 剥离 <session_knowledge> 标签（每次会话不同）
 * 2. 归一化 SessionStart 输出（resume→startup，移除 session-id 和 Last active 行）
 * 3. 移除 "Continue from where you left off." 尾部块
 * 4. 将散落的 skills/deferred tools/MCP/hooks 块归位到第一条 user 消息
 * 5. 剥离纯记账性质的 system-reminder 块（token usage、budget 等）
 * 6. 归一化 microcompact 哨兵文本（移除时间戳抖动）
 * 7. 扩展处理 tool 消息中的 smooshed reminder
 */
export function stripDynamicReminders(messages) {
    if (!Array.isArray(messages)) return messages;

    // ── 阶段1: 文本级归一化（对每条消息的文本内容做静态替换）──

    let modified = false;
    const normalized = messages.map((msg) => {
        // 处理 user 和 tool 消息
        if (msg.role !== 'user' && msg.role !== 'tool') return msg;

        // 字符串形式的 content
        if (typeof msg.content === 'string') {
            let content = msg.content;
            const original = content;

            // 1a. 保留 <session_knowledge> 标签——包含跨轮次上下文锚点，
            //     剥离会导致模型丢失已建立的偏好和项目理解，幻觉增加

            //    移除 <session-id>...</session-id> 标签
            content = content.replace(/<session-id>[^<]*<\/session-id>\s*\n?/g, '');
            //    移除 "Last active: ..." 行
            content = content.replace(/^Last active:.*$\n?/gm, '');

            // 1d. 归一化 microcompact 哨兵（移除时间戳）
            //    "[Old tool result content cleared at 2026-04-30T13:42:11Z]" → "[Old tool result content cleared]"
            content = content.replace(
                /\[Old tool result content cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]/g,
                '[Old tool result content cleared]'
            );

            if (content !== original) {
                modified = true;
                if (!content.trim()) return null;
                return {...msg, content};
            }
            return msg;
        }

        // 数组形式的 content
        if (Array.isArray(msg.content)) {
            let changed = false;
            const processed = msg.content.map((block) => {
                if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
                let text = block.text;
                const original = text;

                // session_knowledge 保留——跨轮次上下文锚点，剥离会导致幻觉增加
                // text = text.replace(/<session_knowledge[^>]*>[\\s\\S]*?<\\/session_knowledge>\\s*/g, '');
                text = text.replace(/<session-id>[^<]*<\/session-id>\s*\n?/g, '');
                text = text.replace(/^Last active:.*$\n?/gm, '');
                // 保留 Continue from where you left off——强信号告诉模型"这是延续对话"
                // text = text.replace(/\n*Continue from where you left off\.\s*$/m, '');
                text = text.replace(
                    /\[Old tool result content cleared at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\]/g,
                    '[Old tool result content cleared]'
                );

                if (text !== original) {
                    changed = true;
                    if (!text.trim()) return null;
                    return {...block, text};
                }
                return block;
            }).filter(Boolean);

            if (changed) {
                modified = true;
                if (processed.length === 0) return null;
                return {...msg, content: processed};
            }
            return msg;
        }

        return msg;
    }).filter(Boolean);

    // ── 阶段2: 剥离纯记账性质的 system-reminder 块 ──

    const REMINDER_WRAP_REGEX = /^<system-reminder>\n([\s\S]*?)\n<\/system-reminder>\s*$/;
    const BOOKKEEPING_PATTERNS = [
        /Token usage:/i,
        /Output tokens/i,
        /USD budget:/i,
        /cache_creation/i,
        /cache_read/i,
        /budget:\s*\$/i
    ];

    function isBookkeepingReminder(text) {
        if (typeof text !== 'string') return false;
        const m = text.match(REMINDER_WRAP_REGEX);
        if (!m) return false;
        return BOOKKEEPING_PATTERNS.some((rx) => rx.test(m[1]));
    }

    const SMOOSHED_REMINDER_REGEX = /\n\n<system-reminder>\n(?:[\s\S]*?)\n<\/system-reminder>\s*$/;

    // 也匹配整条内容就是 reminder 的情况（没有前置正文）
    const STANDALONE_REMINDER_REGEX = /^<system-reminder>\n(?:[\s\S]*?)\n<\/system-reminder>\s*$/;

    let bookkeepingModified = false;
    const result = normalized.map((msg) => {
        // 处理 user 和 tool 消息中的记账 reminder
        if (msg.role !== 'user' && msg.role !== 'tool') return msg;

        if (typeof msg.content === 'string') {
            let content = msg.content;
            let changed = false;

            // 先处理整条内容就是 bookkeeping reminder 的情况
            if (isBookkeepingReminder(content)) {
                bookkeepingModified = true;
                return null;
            }

            // 再处理尾部 smooshed reminder
            while (true) {
                const m = content.match(SMOOSHED_REMINDER_REGEX);
                if (!m) break;
                const stripped = m[0].trim();
                if (isBookkeepingReminder(stripped)) {
                    content = content.slice(0, m.index);
                    changed = true;
                } else {
                    break;
                }
            }
            if (changed) {
                bookkeepingModified = true;
                if (!content.trim()) return null;
                return {...msg, content};
            }
            return msg;
        }

        if (Array.isArray(msg.content)) {
            const kept = msg.content.filter((block) => {
                if (block && block.type === 'text' && isBookkeepingReminder(block.text)) {
                    return false;
                }
                return true;
            });
            if (kept.length === msg.content.length) return msg;
            bookkeepingModified = true;
            if (kept.length === 0) return null;
            return {...msg, content: kept};
        }

        return msg;
    });

    // 清除阶段2 产生的 null（被完全剥离的消息）
    const cleaned = bookkeepingModified ? result.filter(Boolean) : result;

    // ── 阶段3: 将散落的可重定位块归位到第一条 user 消息 ──

    // 检测四类可重定位的 <system-reminder> 块
    function classifyRelocatableBlock(text) {
        if (typeof text !== 'string') return null;
        const m = text.match(REMINDER_WRAP_REGEX);
        if (!m) return null;
        const inner = m[1];
        if (/\bhook success\b/i.test(inner)) return 'hooks';
        if (/\bavailable-skills\b/i.test(inner) || /<available-skills>/i.test(inner)) return 'skills';
        if (/<deferred-tools>/i.test(inner)) return 'deferred';
        if (/<mcp-resources>/i.test(inner) || /Available MCP servers:/i.test(inner)) return 'mcp';
        return null;
    }

    // 对可重定位块的内部内容做确定性排序，确保不同轮次中相同内容产生相同字节
    function stabilizeBlockContent(text, blockType) {
        if (blockType === 'skills') {
            // 对 skills 列表条目按字母序排序
            return text.replace(/(<available-skills>)([\s\S]*?)(<\/available-skills>)/,
                (match, open, inner, close) => {
                    const entries = inner.split(/\n/).filter(l => l.trim());
                    entries.sort();
                    return open + '\n' + entries.join('\n') + '\n' + close;
                });
        }
        if (blockType === 'deferred') {
            // 对 deferred tools 条目按字母序排序
            return text.replace(/(<deferred-tools>)([\s\S]*?)(<\/deferred-tools>)/,
                (match, open, inner, close) => {
                    const entries = inner.split('\n').map(t => t.trim()).filter(Boolean);
                    entries.sort();
                    return open + '\n' + entries.join('\n') + '\n' + close;
                });
        }
        return text;
    }

    // 从字符串 content 中识别和提取可重定位块
    // 返回 { cleaned, extracted: [{type, text}] }
    function extractRelocatableFromString(content) {
        const extracted = [];
        let cleaned = content;
        // 匹配独立的 <system-reminder> 块（前后可能有换行）
        const BLOCK_REGEX = /\n*(<system-reminder>\n[\s\S]*?\n<\/system-reminder>)\s*/g;
        let match;
        while ((match = BLOCK_REGEX.exec(content)) !== null) {
            const blockText = match[1];
            const blockType = classifyRelocatableBlock(blockText);
            if (blockType) {
                const stabilizedText = stabilizeBlockContent(blockText, blockType);
                // originalText 用于从原文中移除，stabilizedText 用于归位
                extracted.push({type: blockType, text: stabilizedText, originalText: blockText});
            }
        }
        // 从原文中移除所有可重定位块
        for (const ext of extracted) {
            // 使用原始文本匹配移除（stabilized 文本可能与原文不匹配）
            cleaned = cleaned.replace(new RegExp(escapeRegExp('\n' + ext.originalText) + '\\s*'), '');
            cleaned = cleaned.replace(new RegExp(escapeRegExp(ext.originalText) + '\\s*'), '');
        }
        return {cleaned, extracted};
    }

    // 按 cache-fix 的固定顺序排列
    const RELOCATE_ORDER = ['deferred', 'mcp', 'skills', 'hooks'];

    // 查找第一条 user 消息的索引
    const firstUserIdx = cleaned.findIndex((msg) => msg.role === 'user');

    if (firstUserIdx >= 0) {
        // 只对前几条 user 消息做归位：这些消息位于缓存前缀范围内，归位能提高命中率
        // 后续 user 消息中的块保持原位不动，避免拉远模型与工具/MCP 信息的上下文距离
        const RELOCATE_USER_LIMIT = 2;
        const allExtracted = [];

        // 统计 user 消息的序号
        let userSeq = 0;
        const relocated = cleaned.map((msg, idx) => {
            if (msg.role !== 'user') return msg;
            userSeq++;
            const shouldRelocate = userSeq <= RELOCATE_USER_LIMIT;

            if (typeof msg.content === 'string') {
                if (!shouldRelocate) return msg;
                const {cleaned, extracted} = extractRelocatableFromString(msg.content);
                if (extracted.length > 0) {
                    allExtracted.push(...extracted);
                    bookkeepingModified = true;
                    if (!cleaned.trim()) return null;
                    return {...msg, content: cleaned};
                }
                return msg;
            }

            if (Array.isArray(msg.content)) {
                if (!shouldRelocate) return msg;
                const extracted = [];
                const kept = msg.content.filter((block) => {
                    if (block && block.type === 'text') {
                        const blockType = classifyRelocatableBlock(block.text);
                        if (blockType) {
                            const stabilizedText = stabilizeBlockContent(block.text, blockType);
                            extracted.push({type: blockType, text: stabilizedText});
                            return false;
                        }
                    }
                    return true;
                });
                if (extracted.length > 0) {
                    allExtracted.push(...extracted);
                    bookkeepingModified = true;
                    if (kept.length === 0) return null;
                    return {...msg, content: kept};
                }
                return msg;
            }

            return msg;
        });

        // 如果提取到了可重定位块，按固定顺序排列后 prepend 到第一条 user 消息
        if (allExtracted.length > 0) {
            // 按 RELOCATE_ORDER 排序，同类型保持原顺序
            const sorted = allExtracted.sort((a, b) => {
                const orderA = RELOCATE_ORDER.indexOf(a.type);
                const orderB = RELOCATE_ORDER.indexOf(b.type);
                return orderA - orderB;
            });

            // pinBlockContent 去重：同一类型中内容 hash 相同的块只保留首次版本
            // 避免不同轮次中同一块因微小空白差异导致前缀不匹配
            const seenByType = new Map();
            const deduped = [];
            for (const ext of sorted) {
                if (!seenByType.has(ext.type)) seenByType.set(ext.type, new Map());
                const typeMap = seenByType.get(ext.type);
                const normalizedText = ext.text.replace(/\s+(<\/system-reminder>)\s*$/, '\n$1');
                const hash = createHash('sha256').update(normalizedText).digest('hex').slice(0, 16);
                if (!typeMap.has(hash)) {
                    typeMap.set(hash, ext.text);
                    deduped.push(ext);
                }
            }

            // 合并为文本
            const relocateText = deduped.map((e) => e.text).join('\n\n');

            // Prepend 到第一条 user 消息
            const firstMsg = relocated[firstUserIdx];
            if (firstMsg) {
                if (typeof firstMsg.content === 'string') {
                    relocated[firstUserIdx] = {...firstMsg, content: relocateText + '\n\n' + firstMsg.content};
                } else if (Array.isArray(firstMsg.content)) {
                    relocated[firstUserIdx] = {
                        ...firstMsg,
                        content: [{type: 'text', text: relocateText}, ...firstMsg.content]
                    };
                }
            }

            return relocated.filter(Boolean);
        }
    }

    if (modified || bookkeepingModified) {
        return cleaned.filter(Boolean);
    }
    return messages;
}

/**
 * 转义正则特殊字符
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 规范化 Responses API 请求体，确保字段顺序和结构稳定
 * Responses API 格式与 Chat Completions 不同，需要独立的规范化逻辑
 * 字段顺序固定、tools 排序、key 递归排序，保证隐式缓存前缀匹配
 */
const RESPONSES_FIELD_ORDER = [
    'model', 'instructions', 'input', 'tools', 'tool_choice',
    'parallel_tool_calls', 'temperature', 'top_p',
    'max_output_tokens', 'reasoning', 'stream', 'store',
    'previous_response_id', 'text', 'caching', 'metadata'
];

export function normalizeResponsesPayload(payload, meta = {}) {
    const ordered = {};
    for (const key of RESPONSES_FIELD_ORDER) {
        if (payload[key] !== undefined) ordered[key] = payload[key];
    }
    for (const key of Object.keys(payload)) {
        if (!(key in ordered)) ordered[key] = payload[key];
    }

    // tools 排序：按 name/type 排序，内部 key 递归排序
    if (ordered.tools) {
        ordered.tools = ordered.tools
            .map((t) => sortObjectKeys(t))
            .sort((a, b) => {
                const nameA = a.name || a.function?.name || a.type || '';
                const nameB = b.name || b.function?.name || b.type || '';
                return nameA.localeCompare(nameB);
            });
    }

    // 清理上游不兼容的参数
    // text.format：火山引擎等不支持 response_format（json_schema/json_object 均不支持），直接移除
    if (ordered.text?.format) {
        const {format, ...rest} = ordered.text;
        if (Object.keys(rest).length > 0) {
            ordered.text = rest;
        } else {
            delete ordered.text;
        }
    }

    return ordered;
}

/**
 * 转换 OpenAI 响应到 Anthropic 格式
 */
export function openAIToAnthropic(openAIResponse) {
    const choice = openAIResponse.choices?.[0];
    if (!choice) {
        return {
            id: openAIResponse.id || generateId(),
            type: 'message',
            role: 'assistant',
            model: openAIResponse.model || 'unknown',
            content: [{type: 'text', text: 'Empty response from upstream API'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: openAIResponse.usage?.prompt_tokens || 0,
                output_tokens: openAIResponse.usage?.completion_tokens || 0,
                cache_read_input_tokens: extractCacheHitTokens(openAIResponse.usage)
            }
        };
    }

    const message = choice.message || {};
    const content = [];

    if (message.content) {
        content.push({
            type: 'text',
            text: message.content
        });
    }

    if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
            let parsedInput = {};
            try {
                parsedInput = JSON.parse(toolCall.function.arguments);
            } catch (e) {
                logger.warn('Failed to parse tool call arguments:', toolCall.function?.arguments?.slice(0, 200));
                parsedInput = {};
            }
            content.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input: parsedInput
            });
        }
    }

    if (content.length === 0) {
        content.push({type: 'text', text: ''});
    }

    return {
        id: openAIResponse.id,
        type: 'message',
        role: 'assistant',
        model: openAIResponse.model,
        content: content,
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openAIResponse.usage?.prompt_tokens || 0,
            output_tokens: openAIResponse.usage?.completion_tokens || 0,
            cache_read_input_tokens: extractCacheHitTokens(openAIResponse.usage)
        }
    };
}

/**
 * 将上游 OpenAI 格式的流式 SSE 数据重写后输出给客户端
 * 核心修复：对 reasoning_content 做缓冲合并，避免 thinking 被逐 token 刷成多个独立块
 *
 * @param {http.ServerResponse} res - 客户端响应
 * @param {ReadableStream} responseBody - 上游流
 * @param {Function} onUsage - usage 统计回调 (inputTokens, outputTokens, cacheHitTokens, credit, model)
 */
export function rewriteOpenAIStream(res, responseBody, onUsage) {
    let reasoningBuffer = ''; // 缓冲 reasoning_content 片段
    let lineBuffer = '';
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let streamCacheHitTokens = 0;
    let streamCredit = 0;
    let streamModel = '';

    function flushReasoning() {
        if (!reasoningBuffer) return;
        const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: streamModel || 'unknown',
            choices: [
                {
                    index: 0,
                    delta: {role: 'assistant', reasoning_content: reasoningBuffer},
                    finish_reason: null
                }
            ]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        reasoningBuffer = '';
    }

    responseBody.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) {
                res.write(line + '\n');
                continue;
            }
            if (!trimmed.startsWith('data: ')) {
                res.write(line + '\n');
                continue;
            }

            const raw = trimmed.slice(6).trim();
            if (raw === '[DONE]') {
                flushReasoning();
                res.write('data: [DONE]\n\n');
                continue;
            }

            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                res.write(line + '\n');
                continue;
            }

            // 提取 usage
            if (data.usage) {
                streamInputTokens = data.usage.prompt_tokens || 0;
                streamOutputTokens = data.usage.completion_tokens || 0;
                streamCacheHitTokens =
                    data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0;
                streamCredit = data.usage.credit || 0;
            }
            if (data.model) streamModel = data.model;

            const choice = data.choices?.[0];
            const delta = choice?.delta;
            if (!choice || !delta) {
                res.write(line + '\n');
                continue;
            }

            // 提取 reasoning 文本
            let reasoningText = null;
            if (delta.reasoning_content) {
                reasoningText = delta.reasoning_content;
            } else if (typeof delta.thinking === 'string') {
                reasoningText = delta.thinking;
            } else if (typeof delta.thinking === 'object' && delta.thinking !== null) {
                reasoningText = delta.thinking.content || null;
            }

            if (reasoningText) {
                // 缓冲 reasoning，不立即输出
                reasoningBuffer += reasoningText;
                continue;
            }

            // 遇到非 reasoning 内容（content/tool_calls/finish_reason），先 flush 缓冲的 reasoning
            if (delta.content || Array.isArray(delta.tool_calls) || choice.finish_reason) {
                flushReasoning();
            }

            // 正常内容直接透传
            res.write(line + '\n');
        }
    });

    responseBody.on('end', () => {
        flushReasoning();
        if (lineBuffer.trim()) {
            res.write(lineBuffer + '\n');
        }
        if (onUsage) {
            onUsage(streamInputTokens, streamOutputTokens, streamCacheHitTokens, streamCredit, streamModel);
        }
        res.end();
    });

    responseBody.on('error', (err) => {
        logger.error('OpenAI stream rewrite error:', err);
        flushReasoning();
        res.end();
    });
}
