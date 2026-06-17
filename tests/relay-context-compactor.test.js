import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayUpstreamError} from '../src/services/relay/api.js';
import {
    RELAY_COMPACTION_SUMMARY_PREFIX,
    compactChatRequestIfNeeded,
    estimateChatRequestTokens,
    inferModelContextWindowTokens,
    isContextWindowExceededError,
    resolveContextCompactionPolicy
} from '../src/services/relay/context-compactor.js';

function message(role, content) {
    return {role, content};
}

test('compactChatRequestIfNeeded keeps small requests unchanged', async () => {
    let summarizeCalls = 0;
    const chatRequest = {
        model: 'test-model',
        messages: [
            message('system', 'You are concise.'),
            message('user', 'hello')
        ]
    };

    const result = await compactChatRequestIfNeeded({
        chatRequest,
        summarize: async () => {
            summarizeCalls++;
            return 'unused';
        },
        config: {
            enabled: true,
            thresholdTokens: 10_000,
            recentTokens: 2000,
            summaryTokens: 512
        }
    });

    assert.equal(result.compacted, false);
    assert.equal(result.chatRequest, chatRequest);
    assert.equal(summarizeCalls, 0);
});

test('compactChatRequestIfNeeded replaces old history with one summary and recent tail', async () => {
    const oldText = 'old-context '.repeat(200);
    const recentText = 'recent-context '.repeat(20);
    const chatRequest = {
        model: 'test-model',
        messages: [
            message('system', 'You are a coding assistant.'),
            message('user', oldText + 'question 1'),
            message('assistant', oldText + 'answer 1'),
            message('user', oldText + 'question 2'),
            message('assistant', oldText + 'answer 2'),
            message('user', recentText + 'latest question')
        ],
        tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
        tool_choice: 'auto'
    };

    const result = await compactChatRequestIfNeeded({
        chatRequest,
        summarize: async ({messages, previousSummary, targetTokens}) => {
            assert.equal(previousSummary, '');
            assert.equal(targetTokens, 256);
            assert.deepEqual(messages.map((item) => item.role), ['user', 'assistant', 'user', 'assistant']);
            return 'Summary of old turns, tool decisions, files mentioned, and open tasks.';
        },
        config: {
            enabled: true,
            thresholdTokens: 100,
            recentTokens: 20,
            summaryTokens: 256
        }
    });

    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'threshold');
    assert.deepEqual(result.chatRequest.tools, chatRequest.tools);
    assert.equal(result.chatRequest.tool_choice, 'auto');
    assert.deepEqual(result.chatRequest.messages.map((item) => item.role), ['system', 'system', 'user']);
    assert.equal(result.chatRequest.messages[0].content, 'You are a coding assistant.');
    assert.equal(
        result.chatRequest.messages[1].content,
        `${RELAY_COMPACTION_SUMMARY_PREFIX}\nSummary of old turns, tool decisions, files mentioned, and open tasks.`
    );
    assert.equal(result.chatRequest.messages.at(-1).content.includes('latest question'), true);
    assert.equal(estimateChatRequestTokens(result.chatRequest) < estimateChatRequestTokens(chatRequest), true);
});

test('compactChatRequestIfNeeded folds a previous relay summary into the replacement summary', async () => {
    const chatRequest = {
        model: 'test-model',
        messages: [
            message('system', 'Original system'),
            message('system', `${RELAY_COMPACTION_SUMMARY_PREFIX}\nPrevious compact summary.`),
            message('user', 'older turn '.repeat(150)),
            message('assistant', 'older answer '.repeat(150)),
            message('user', 'current question')
        ]
    };

    const result = await compactChatRequestIfNeeded({
        chatRequest,
        summarize: async ({previousSummary, messages}) => {
            assert.equal(previousSummary, 'Previous compact summary.');
            assert.deepEqual(messages.map((item) => item.role), ['user', 'assistant']);
            return 'Updated compact summary.';
        },
        config: {
            enabled: true,
            thresholdTokens: 50,
            recentTokens: 10,
            summaryTokens: 128
        }
    });

    const summaries = result.chatRequest.messages.filter((item) =>
        typeof item.content === 'string' && item.content.startsWith(RELAY_COMPACTION_SUMMARY_PREFIX)
    );
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].content, `${RELAY_COMPACTION_SUMMARY_PREFIX}\nUpdated compact summary.`);
});

test('resolveContextCompactionPolicy defaults unmarked models to 200k', () => {
    for (const model of ['deepseek-chat', 'claude-3-5-sonnet-20241022', 'glm-5.2', 'kimi-k2.7', 'deepseek-v4-pro']) {
        const policy = resolveContextCompactionPolicy(model);
        assert.equal(policy.contextWindowTokens, 200_000);
        assert.equal(policy.thresholdTokens, 140_000);
        assert.equal(policy.recentTokens, 50_000);
        assert.equal(policy.summaryTokens, 4096);
    }
});

test('resolveContextCompactionPolicy uses bracketed 1m marker', () => {
    const policy = resolveContextCompactionPolicy('glm-5.2 [1m]');
    assert.equal(policy.contextWindowTokens, 1_000_000);
    assert.equal(policy.thresholdTokens, 700_000);
    assert.equal(policy.recentTokens, 250_000);
    assert.equal(policy.summaryTokens, 4096);
});

test('inferModelContextWindowTokens only honors bracketed 1m marker', () => {
    assert.equal(inferModelContextWindowTokens('provider-model-32k'), 200_000);
    assert.equal(inferModelContextWindowTokens('custom-model-1m'), 200_000);
    assert.equal(inferModelContextWindowTokens('custom-model [1m]'), 1_000_000);
    assert.equal(inferModelContextWindowTokens('custom-model [1M]'), 1_000_000);
    assert.equal(inferModelContextWindowTokens('unknown-private-model'), 200_000);
});

test('compactChatRequestIfNeeded ignores legacy env thresholds and uses automatic policy', async () => {
    const previous = {
        enabled: process.env.RELAY_CONTEXT_COMPACTION_ENABLED,
        threshold: process.env.RELAY_CONTEXT_COMPACTION_THRESHOLD_TOKENS,
        recent: process.env.RELAY_CONTEXT_COMPACTION_RECENT_TOKENS,
        summary: process.env.RELAY_CONTEXT_COMPACTION_SUMMARY_TOKENS
    };
    process.env.RELAY_CONTEXT_COMPACTION_ENABLED = 'false';
    process.env.RELAY_CONTEXT_COMPACTION_THRESHOLD_TOKENS = '1';
    process.env.RELAY_CONTEXT_COMPACTION_RECENT_TOKENS = '1';
    process.env.RELAY_CONTEXT_COMPACTION_SUMMARY_TOKENS = '1';

    try {
        let summarizeCalls = 0;
        const chatRequest = {
            model: 'deepseek-chat',
            messages: [
                message('system', 'Original system'),
                message('user', 'short but above one env token'),
                message('assistant', 'still small for the automatic deepseek threshold'),
                message('user', 'latest question')
            ]
        };

        const result = await compactChatRequestIfNeeded({
            chatRequest,
            summarize: async () => {
                summarizeCalls++;
                return 'unused';
            }
        });

        assert.equal(result.compacted, false);
        assert.equal(result.reason, 'below_threshold');
        assert.equal(summarizeCalls, 0);
    } finally {
        restoreEnv('RELAY_CONTEXT_COMPACTION_ENABLED', previous.enabled);
        restoreEnv('RELAY_CONTEXT_COMPACTION_THRESHOLD_TOKENS', previous.threshold);
        restoreEnv('RELAY_CONTEXT_COMPACTION_RECENT_TOKENS', previous.recent);
        restoreEnv('RELAY_CONTEXT_COMPACTION_SUMMARY_TOKENS', previous.summary);
    }
});

test('compactChatRequestIfNeeded triggers using the automatic model threshold', async () => {
    const oldText = 'old-auto-context '.repeat(30000);
    const recentText = 'recent-auto-context '.repeat(200);
    const chatRequest = {
            model: 'test-auto-default',
        messages: [
            message('system', 'Original system'),
            message('user', oldText + 'question 1'),
            message('assistant', oldText + 'answer 1'),
            message('user', recentText + 'latest question')
        ]
    };

    const result = await compactChatRequestIfNeeded({
        chatRequest,
        summarize: async ({targetTokens}) => {
            assert.equal(targetTokens, 4096);
            return 'Automatic policy summary.';
        }
    });

    assert.equal(result.compacted, true);
    assert.equal(result.reason, 'threshold');
    assert.equal(result.chatRequest.messages[1].content, `${RELAY_COMPACTION_SUMMARY_PREFIX}\nAutomatic policy summary.`);
});

test('isContextWindowExceededError matches only context-window 400 errors', () => {
    assert.equal(
        isContextWindowExceededError(new RelayUpstreamError('[upstream]: HTTP 400: context window exceeded', 400)),
        true
    );
    assert.equal(
        isContextWindowExceededError(new RelayUpstreamError('[upstream]: HTTP 400: maximum context length is 128000 tokens', 400)),
        true
    );
    assert.equal(
        isContextWindowExceededError(new RelayUpstreamError('[upstream]: HTTP 429: Requests are too frequent', 429)),
        false
    );
    assert.equal(
        isContextWindowExceededError(new RelayUpstreamError('[upstream]: HTTP 400: invalid tool schema', 400)),
        false
    );
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
