/**
 * 公共协议适配逻辑
 * 抽取自 CodeBuddy/Relay 产品适配器的重复代码
 * @module protocol-engine/core/shared
 */

import {randomBytes, createHash} from 'crypto';

/**
 * 从上游 usage 中提取缓存命中 token 数
 * 覆盖四种上游协议的字段：
 * - DeepSeek Chat: prompt_cache_hit_tokens
 * - OpenAI Chat: prompt_tokens_details.cached_tokens
 * - Anthropic: cache_read_input_tokens
 * - Responses: input_tokens_details.cached_tokens
 */
export function extractCacheHitTokens(usage) {
    if (!usage) return 0;
    return usage.prompt_cache_hit_tokens
        || usage.prompt_tokens_details?.cached_tokens
        || usage.cache_read_input_tokens
        || usage.input_tokens_details?.cached_tokens
        || 0;
}

export function extractInputTokens(usage) {
    if (!usage) return 0;
    if (usage.prompt_tokens !== undefined) return usage.prompt_tokens || 0;
    if (usage.input_tokens !== undefined) {
        return (usage.input_tokens || 0)
            + (usage.cache_read_input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0);
    }
    return 0;
}

export function openAIUsageToAnthropicUsage(usage) {
    const promptTokens = usage?.prompt_tokens || 0;
    const cacheReadTokens = extractCacheHitTokens(usage);
    const promptDetails = usage?.prompt_tokens_details || {};
    const cacheReadInsidePrompt = promptDetails.cached_tokens || 0;
    return {
        input_tokens: Math.max(0, promptTokens - cacheReadInsidePrompt),
        output_tokens: usage?.completion_tokens || 0,
        cache_read_input_tokens: cacheReadTokens
    };
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
    const validBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
    if (validBlocks.length === 1 && validBlocks[0].type === 'text') {
        return validBlocks[0].text;
    }

    const mapped = validBlocks
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
 * @param {string} [modelId] - 保留用于兼容旧调用方，当前不参与提示词选择
 * @returns {Array} 注入后的 messages 数组
 */
export function injectBehaviorRules(messages, modelId, options = {}) {
    void modelId;
    const behaviorRules = options.behaviorRules || '';
    if (!behaviorRules) return messages;

    const result = [];

    const systemIndex = messages.findIndex((m) => m.role === 'system');

    if (systemIndex >= 0) {
        const originalSystem = messages[systemIndex].content;
        const systemStr =
            typeof originalSystem === 'string' ? originalSystem : originalSystem.map((p) => p.text ?? '').join('\n');
        // 客户端 system 已包含代理行为规则时跳过注入，避免重复。
        // 同时识别旧版提示词标签，避免历史会话重复叠加规则。
        const alreadyHasRules = systemStr.includes('<thinking_language>')
            || systemStr.includes('<reasoning-rules>')
            || systemStr.includes('<cognition>')
            || systemStr.includes('<identity>');
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

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') {
            stableLines.push(line);
            continue;
        }

        // 剥离纯记账行，其余（env/git/memory 等）保留原值
        const result = normalizeDynamicLine(trimmed);
        if (result.action === 'drop') continue;
        stableLines.push(normalizeCodeAgentTodayDateLine(line));
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
    if (/fingerprint[-:][a-f0-9]{6,}/i.test(line)) return {action: 'drop'};
    if (/^cc_version:/i.test(line)) return {action: 'drop'};
    // commit hash 行由 extractStableContent 的 isGitStatusLine 在 git 块上下文中处理，
    // 不在此全局匹配，避免误杀非 git 的十六进制内容（如配置值、ID 等）

    // ── 以下行全在前缀范围外，保留原值不影响缓存 ──
    return {action: 'keep'};
}

// Anthropic 的 Claude Code 客户端会用撇号变体和日期分隔符编码客户端地域/时区痕迹。
// 这里只归一化它生成的 "Today's date is ..." 行，避免影响无关用户文本。
function normalizeCodeAgentTodayDateLine(line) {
    return line.replace(
        /\b([Tt]oday)[\u2018\u2019\u02bc\u02b9']s(\s+date\s+is\s+)(\d{4})[-/](\d{2})[-/](\d{2})\b/g,
        "$1's$2$3-$4-$5"
    );
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

function normalizeAnchorIdentity(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractEmbeddedSessionId(value, depth = 0) {
    if (depth > 8 || value == null) return undefined;
    if (typeof value === 'string') {
        const tagMatch = value.match(/<session-id>\s*([^<]+?)\s*<\/session-id>/i);
        if (tagMatch) return normalizeAnchorIdentity(tagMatch[1]);
        const lineMatch = value.match(/(?:^|\n)\s*sessionId:\s*([^\n]+)/i);
        return normalizeAnchorIdentity(lineMatch?.[1]);
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = extractEmbeddedSessionId(item, depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof value === 'object') {
        for (const item of Object.values(value)) {
            const found = extractEmbeddedSessionId(item, depth + 1);
            if (found) return found;
        }
    }
    return undefined;
}

function extractPayloadConversationIdentity(payload) {
    const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const candidates = [
        payload?.session_id,
        payload?.sessionId,
        metadata.session_id,
        metadata.sessionId,
        extractEmbeddedSessionId(payload),
        payload?.conversation_id,
        payload?.conversationId,
        metadata.conversation_id,
        metadata.conversationId,
        payload?.thread_id,
        payload?.threadId,
        metadata.thread_id,
        metadata.threadId
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAnchorIdentity(candidate);
        if (normalized) return normalized;
    }
    return undefined;
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

    const conversationIdentity = extractPayloadConversationIdentity(payload);
    if (conversationIdentity) {
        anchors.push('sid:' + hashAnchor(conversationIdentity, 500));
    }

    const firstUserMsg = messages.find((message) => (message.role || message.type) === 'user');
    if (firstUserMsg && !conversationIdentity) {
        anchors.push('u:' + hashAnchor(firstUserMsg.content, 300));
    }

    if (!conversationIdentity && meta.clientConnectionId) {
        anchors.push('cid:' + hashAnchor(meta.clientConnectionId, 500));
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
    delete ordered.previous_response_id;

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
 * 仅剥离 Claude Code resume 文本中的 Last active 行。
 *
 * 其它动态内容保留原位：session-id / sessionId、session_knowledge、
 * SessionStart、Continue from where you left off、记账 reminder、MCP/skills/hooks
 * reminder 以及 microcompact 时间戳都可能影响模型语义，不能为了前缀缓存过度清理。
 */
export function stripDynamicReminders(messages) {
    if (!Array.isArray(messages)) return messages;

    let conservativeModified = false;
    const stripLastActive = (text) => text.replace(/^Last active:.*$\n?/gm, '');
    const conservative = messages.map((msg) => {
        if (msg.role !== 'user' && msg.role !== 'tool') return msg;

        if (typeof msg.content === 'string') {
            const content = stripLastActive(msg.content);
            if (content !== msg.content) {
                conservativeModified = true;
                if (!content.trim()) return null;
                return {...msg, content};
            }
            return msg;
        }

        if (Array.isArray(msg.content)) {
            let changed = false;
            const content = msg.content.map((block) => {
                if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
                const text = stripLastActive(block.text);
                if (text !== block.text) {
                    changed = true;
                    if (!text.trim()) return null;
                    return {...block, text};
                }
                return block;
            }).filter(Boolean);

            if (changed) {
                conservativeModified = true;
                if (content.length === 0) return null;
                return {...msg, content};
            }
        }

        return msg;
    }).filter(Boolean);

    return conservativeModified ? conservative : messages;
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

/**
 * 判断模型是否支持 Responses API 的 partial（prefill）续写模式。
 * 火山引擎仅 doubao-seed 系列支持 partial，glm 等其他模型传 partial 会报 400：
 *   "The parameter `partial` specified in the request are not valid: partial (prefill) is not supported by current model"
 * 支持清单参考火山引擎文档（doubao-seed-2-0-* / doubao-seed-1-8-* / doubao-seed-1-6-* / doubao-seed-code-preview-*）。
 */
export function isDoubaoSeedModel(model) {
    return /^doubao-seed/i.test(String(model || '').trim());
}

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

    // reasoning：火山引擎 Responses API 的 reasoning.effort 仅部分模型支持
    // （doubao-seed-2-0-lite-260428、doubao-seed-2-0-pro-260215、doubao-seed-1-8-251228、doubao-seed-1-6-251015 等）
    // codingplan 等模型不支持 reasoning 参数会报 400，需要转为 thinking 参数控制深度思考
    // 映射规则参考字节文档：
    //   reasoning.effort = "high"/"medium"/"low" → thinking: {type: "enabled"}
    //   reasoning.effort = "minimal" 或无 effort → thinking: {type: "disabled"}
    //   已有 thinking 字段时不覆盖（用户可能已显式设置）
    if (ordered.reasoning) {
        const effort = ordered.reasoning.effort;
        delete ordered.reasoning;
        if (!ordered.thinking) {
            if (effort && effort !== 'minimal') {
                ordered.thinking = {type: 'enabled'};
            } else {
                ordered.thinking = {type: 'disabled'};
            }
        }
    }

    // input 尾部 assistant 消息的模型相关处理：
    // 火山引擎 Responses API：partial 只能用在 input 最后一条消息上，且必须为 true
    // 中间的 assistant 消息不能带 partial 字段，否则报 400
    // - doubao-seed 系列：支持 partial（prefill）续写，保留尾部 assistant 并注入 partial:true
    // - 其他模型（如 glm）：不支持 prefill，最后一条消息不能是 assistant 角色，否则上游 400：
    //   "The last message cannot be from the assistant for a model that does not support prefill"
    //   此时丢弃尾部 assistant 消息，让 input 退回以 user 结尾的合法形态（符合官方文档 input 约定）。
    //   与 sanitizeResponsesInput 末尾逻辑保持一致，覆盖 relay HTTP 透传路径。
    if (Array.isArray(ordered.input) && ordered.input.length > 0) {
        const lastItem = ordered.input[ordered.input.length - 1];
        if (lastItem?.role === 'assistant') {
            if (lastItem.partial === undefined && isDoubaoSeedModel(ordered.model)) {
                lastItem.partial = true;
            } else if (!isDoubaoSeedModel(ordered.model)) {
                ordered.input.pop();
            }
        }
    }

    // 强制 store:true：
    // responses 协议的 previous_response_id 续接依赖上游服务端存储。
    // codex 等客户端默认 store:false，若原样透传，首响不会被上游保存，
    // 后续轮次用 previous_response_id 引用必然 404 PreviousResponseNotFound。
    // 首响（不带 previous_response_id）才是建立存储的那一轮，必须 store:true；
    // 续接轮（带 previous_response_id）同样需要存住本轮以供再后续引用。
    // 本函数仅服务于 responses HTTP 上游，强制 true 安全。
    ordered.store = true;

    return ordered;
}

/**
 * 转换 OpenAI 响应到 Anthropic 格式
 */
export function openAIToAnthropic(openAIResponse, options = {}) {
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
            usage: openAIUsageToAnthropicUsage(openAIResponse.usage)
        };
    }

    const message = choice.message || {};
    const content = [];

    // 恢复 reasoning_content → thinking 块（chat 上游 reasoning 无签名来源，注入占位签名）
    const reasoningText = message.reasoning_content
        || (typeof message.thinking === 'string' ? message.thinking : null)
        || (typeof message.thinking === 'object' && message.thinking !== null ? message.thinking.content : null)
        || (typeof message.reasoning === 'string' ? message.reasoning : null)
        || (typeof message.thought === 'string' ? message.thought : null);
    if (reasoningText) {
        content.push({
            type: 'thinking',
            thinking: reasoningText,
            signature: generateId()
        });
    }

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
                options.logger?.warn?.('Failed to parse tool call arguments:', toolCall.function?.arguments?.slice(0, 200));
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
        usage: openAIUsageToAnthropicUsage(openAIResponse.usage)
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
export function rewriteOpenAIStream(res, responseBody, onUsage, onChunk, options = {}) {
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
            onChunk?.(data);
            if (data.usage) {
                streamInputTokens = data.usage.prompt_tokens || 0;
                streamOutputTokens = data.usage.completion_tokens || 0;
                streamCacheHitTokens = extractCacheHitTokens(data.usage);
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
        options.logger?.error?.('OpenAI stream rewrite error:', err);
        flushReasoning();
        res.end();
    });
}
