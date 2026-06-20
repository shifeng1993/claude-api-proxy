import {estimateMessageTokens, roughTokenCountEstimation} from '../../utils/token-estimation.js';

export const RELAY_COMPACTION_SUMMARY_PREFIX = '[Relay conversation summary]';

const DEFAULT_SUMMARY_TOKENS = 2048;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const TRIGGER_RATIO = 0.90;
const RECENT_RATIO = 0.25;
const MIN_RECENT_TOKENS = 2_000;
const MAX_RECENT_TOKENS = 256_000;

export function inferModelContextWindowTokens(model) {
    return hasOneMillionContextMarker(model) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function resolveContextCompactionPolicy(modelOrRequest) {
    const model = typeof modelOrRequest === 'object' && modelOrRequest !== null
        ? modelOrRequest.model
        : modelOrRequest;
    const contextWindowTokens = inferModelContextWindowTokens(model);
    return {
        enabled: true,
        contextWindowTokens,
        thresholdTokens: Math.floor(contextWindowTokens * TRIGGER_RATIO),
        recentTokens: clamp(
            Math.floor(contextWindowTokens * RECENT_RATIO),
            MIN_RECENT_TOKENS,
            MAX_RECENT_TOKENS
        ),
        summaryTokens: contextWindowTokens <= 32_000
            ? 1024
            : contextWindowTokens >= 128_000
                ? 4096
                : DEFAULT_SUMMARY_TOKENS
    };
}

export function estimateChatRequestTokens(chatRequest) {
    if (!chatRequest || typeof chatRequest !== 'object') return 0;
    const messageTokens = estimateMessageTokens(chatRequest.messages || []);
    const toolTokens = Array.isArray(chatRequest.tools)
        ? roughTokenCountEstimation(JSON.stringify(chatRequest.tools), 2)
        : 0;
    return messageTokens + toolTokens;
}

export async function compactChatRequestIfNeeded({
    chatRequest,
    summarize,
    force = false,
    reason,
    config
}) {
    if (!chatRequest || !Array.isArray(chatRequest.messages)) {
        return unchanged(chatRequest, 'invalid_request');
    }
    const policy = config ? normalizeContextCompactionPolicy(config, chatRequest) : resolveContextCompactionPolicy(chatRequest);
    if (!policy.enabled) {
        return unchanged(chatRequest, 'disabled');
    }

    const estimatedTokens = estimateChatRequestTokens(chatRequest);
    if (!force && estimatedTokens <= policy.thresholdTokens) {
        return unchanged(chatRequest, 'below_threshold', estimatedTokens);
    }

    const split = splitMessagesForCompaction(chatRequest.messages, policy.recentTokens);
    if (split.oldMessages.length === 0) {
        return unchanged(chatRequest, 'no_old_messages', estimatedTokens);
    }

    const summaryRequest = buildContextSummaryChatRequest({
        model: chatRequest.model,
        messages: split.oldMessages,
        previousSummary: split.previousSummary,
        targetTokens: policy.summaryTokens
    });
    const summary = normalizeSummary(await summarize({
        messages: clone(split.oldMessages),
        previousSummary: split.previousSummary,
        targetTokens: policy.summaryTokens,
        summaryRequest
    }));

    if (!summary) {
        return unchanged(chatRequest, 'empty_summary', estimatedTokens);
    }

    const compactedMessages = buildCompactedMessages({
        systemMessages: split.systemMessages,
        summary,
        recentMessages: split.recentMessages
    });
    const compactedRequest = {
        ...clone(chatRequest),
        messages: compactedMessages
    };
    const compactedTokens = estimateChatRequestTokens(compactedRequest);

    return {
        compacted: true,
        reason: reason || (force ? 'forced' : 'threshold'),
        estimatedTokens,
        compactedTokens,
        oldMessageCount: split.oldMessages.length,
        recentMessageCount: split.recentMessages.length,
        chatRequest: compactedRequest
    };
}

export function buildContextSummaryChatRequest({model, messages, previousSummary = '', targetTokens = DEFAULT_SUMMARY_TOKENS}) {
    const previousSection = previousSummary
        ? `Existing compact summary to update:\n${previousSummary}\n\n`
        : '';
    return {
        model,
        stream: false,
        max_tokens: targetTokens,
        temperature: 0,
        messages: [
            {
                role: 'system',
                content: [
                    'You compact relay conversation history for a coding agent proxy.',
                    'Produce one dense, factual summary that can replace the older turns.',
                    'Preserve user goals, decisions, constraints, file paths, commands, tool calls/results, errors, IDs, and unresolved tasks.',
                    'Preserve important details in their original language. Do not invent facts. Omit greetings and repetitive raw logs unless they are necessary.',
                    `Keep the summary under about ${targetTokens} tokens.`
                ].join('\n')
            },
            {
                role: 'user',
                content: `${previousSection}Older conversation turns to compact:\n${formatMessagesForSummary(messages)}`
            }
        ]
    };
}

export function isContextWindowExceededError(error) {
    const status = Number(error?.status || error?.event?.status || error?.code);
    if (status !== 400) return false;
    const message = `${error?.message || ''} ${JSON.stringify(error?.event || {})}`;
    return /context\s*(window|length)?\s*(exceeded|exceed|too large|too long)|maximum\s+context|context_length_exceeded|too many tokens|input tokens.*exceed|maximum\s+of\s+\d+\s+items\s+allowed\s+in\s+input/i.test(message);
}

function splitMessagesForCompaction(messages, recentTokens) {
    const systemMessages = [];
    const conversationMessages = [];
    const previousSummaries = [];
    let inLeadingSystem = true;

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        if (inLeadingSystem && (message.role === 'system' || message.role === 'developer')) {
            const splitSystem = splitRelaySummaryFromContent(message.content);
            if (splitSystem.summary) previousSummaries.push(splitSystem.summary);
            if (splitSystem.content) {
                systemMessages.push({...clone(message), content: splitSystem.content});
            }
            continue;
        }
        if (isRelaySummaryMessage(message)) {
            previousSummaries.push(stripSummaryPrefix(message.content));
            continue;
        }
        inLeadingSystem = false;
        conversationMessages.push(clone(message));
    }

    let tailStart = conversationMessages.length;
    let tailTokens = 0;
    while (tailStart > 0 && (tailTokens < recentTokens || tailStart === conversationMessages.length)) {
        tailStart--;
        tailTokens += estimateMessageTokens([conversationMessages[tailStart]]);
    }

    while (tailStart > 0 && conversationMessages[tailStart]?.role === 'tool') {
        tailStart--;
    }

    while (tailStart > 0 && conversationMessages[tailStart]?.role !== 'user') {
        tailStart--;
    }

    return {
        systemMessages,
        previousSummary: previousSummaries.filter(Boolean).join('\n\n'),
        oldMessages: conversationMessages.slice(0, tailStart),
        recentMessages: conversationMessages.slice(tailStart)
    };
}

function isRelaySummaryMessage(message) {
    return typeof message?.content === 'string'
        && message.content.startsWith(RELAY_COMPACTION_SUMMARY_PREFIX);
}

function splitRelaySummaryFromContent(content) {
    if (typeof content !== 'string') return {content, summary: ''};
    const summaryIndex = content.indexOf(RELAY_COMPACTION_SUMMARY_PREFIX);
    if (summaryIndex < 0) return {content, summary: ''};
    return {
        content: content.slice(0, summaryIndex).trim(),
        summary: content.slice(summaryIndex + RELAY_COMPACTION_SUMMARY_PREFIX.length).trim()
    };
}

function buildCompactedMessages({systemMessages, summary, recentMessages}) {
    const summaryContent = `${RELAY_COMPACTION_SUMMARY_PREFIX}\n${summary}`;
    if (!Array.isArray(systemMessages) || systemMessages.length === 0) {
        return [{role: 'system', content: summaryContent}, ...recentMessages];
    }

    const systemContent = systemMessages
        .map((message) => contentToText(message.content))
        .filter(Boolean)
        .join('\n\n');

    return [
        {
            ...clone(systemMessages[0]),
            role: 'system',
            content: [systemContent, summaryContent].filter(Boolean).join('\n\n')
        },
        ...recentMessages
    ];
}

function stripSummaryPrefix(content) {
    return String(content || '').replace(RELAY_COMPACTION_SUMMARY_PREFIX, '').trim();
}

function formatMessagesForSummary(messages) {
    return (messages || [])
        .map((message, index) => {
            const parts = [`Turn ${index + 1}`, `role: ${message.role || 'unknown'}`];
            const text = contentToText(message.content);
            if (text) parts.push(`content:\n${text}`);
            if (message.reasoning_content) parts.push(`reasoning:\n${message.reasoning_content}`);
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                parts.push(`tool_calls:\n${safeStringify(message.tool_calls)}`);
            }
            if (message.tool_call_id) parts.push(`tool_call_id: ${message.tool_call_id}`);
            return parts.join('\n');
        })
        .join('\n\n---\n\n');
}

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (!Array.isArray(content)) return safeStringify(content);
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.text) return part.text;
            if (part.input_text) return part.input_text;
            if (part.output_text) return part.output_text;
            return safeStringify(part);
        })
        .filter(Boolean)
        .join('\n');
}

function normalizeSummary(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function unchanged(chatRequest, reason, estimatedTokens = estimateChatRequestTokens(chatRequest)) {
    return {
        compacted: false,
        reason,
        estimatedTokens,
        compactedTokens: estimatedTokens,
        oldMessageCount: 0,
        recentMessageCount: Array.isArray(chatRequest?.messages) ? chatRequest.messages.length : 0,
        chatRequest
    };
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function hasOneMillionContextMarker(model) {
    return /\[\s*1\s*m\s*\]/i.test(String(model || ''));
}

function normalizeContextCompactionPolicy(config, chatRequest) {
    const automatic = resolveContextCompactionPolicy(chatRequest);
    if (!config || typeof config !== 'object') return automatic;
    return {
        ...automatic,
        ...config,
        enabled: config.enabled !== false,
        thresholdTokens: readPositiveNumber(config.thresholdTokens, automatic.thresholdTokens),
        recentTokens: readPositiveNumber(config.recentTokens, automatic.recentTokens),
        summaryTokens: readPositiveNumber(config.summaryTokens, automatic.summaryTokens)
    };
}

function readPositiveNumber(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
