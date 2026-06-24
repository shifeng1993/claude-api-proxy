import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {
    compactRelayChatRequest,
    createRelayContextCompaction,
    generateRelayContextSummary,
    invokeWithRelayContextCompaction
} from '../src/services/relay/context-compaction.js';

function createLoggerRecorder() {
    const messages = [];
    return {
        messages,
        logger: {
            info: (message) => messages.push(['info', message]),
            warn: (message) => messages.push(['warn', message])
        }
    };
}

test('generateRelayContextSummary calls Chat upstream and records usage', async () => {
    const usageCalls = [];
    const summary = await generateRelayContextSummary({
        summaryRequest: {
            model: 'client-model',
            messages: [{role: 'user', content: 'old history'}]
        },
        upstream: {index: 1, protocol: 'chat'},
        upstreamManager: {
            resolveModel: (model, index) => `${model}@${index}`
        },
        tenantId: 42,
        conversationKey: 'conv-1',
        originalModel: 'client-model',
        requestType: 'ResponsesViaChat',
        isAnthropicUpstream: () => false,
        callUpstream: async (upstream, invoke) => ({response: await invoke(upstream)}),
        createChatCompletions: async (payload, upstream, meta) => {
            assert.equal(payload.model, 'client-model@1');
            assert.equal(payload.stream, false);
            assert.equal(meta.requestType, 'ResponsesViaChatContextCompaction');
            assert.equal(meta.conversationKey, 'conv-1:compact');
            assert.equal(upstream.protocol, 'chat');
            return {
                body: Readable.from([Buffer.from(JSON.stringify({
                    choices: [{message: {content: 'condensed summary'}}],
                    usage: {prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: {cached_tokens: 2}}
                }))])
            };
        },
        readResponseBody: async (body) => {
            const chunks = [];
            for await (const chunk of body) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        },
        recordUsage: (...args) => usageCalls.push(args),
        extractCacheHitTokens: (usage) => usage.prompt_tokens_details?.cached_tokens || 0
    });

    assert.equal(summary, 'condensed summary');
    assert.deepEqual(usageCalls, [[42, 11, 5, 2, 'client-model@1']]);
});

test('generateRelayContextSummary calls Anthropic upstream and converts response to chat usage', async () => {
    const usageCalls = [];
    const summary = await generateRelayContextSummary({
        summaryRequest: {
            model: 'client-model',
            messages: [{role: 'user', content: 'old history'}]
        },
        upstream: {index: 0, protocol: 'anthropic'},
        upstreamManager: {
            resolveModel: (model, index) => `${model}@${index}`
        },
        tenantId: 42,
        tenantMeta: {tenantName: 'Acme'},
        conversationKey: 'conv-1',
        originalModel: 'client-model',
        requestType: 'ResponsesViaAnthropic',
        req: {headers: {'anthropic-beta': 'tools'}},
        isAnthropicUpstream: () => true,
        chatRequestToAnthropic: (payload) => ({anthropic: payload}),
        createAnthropicMessages: async (payload, upstream, meta, headers) => {
            assert.equal(payload.anthropic.model, 'client-model@0');
            assert.equal(meta.requestType, 'ResponsesViaAnthropicContextCompaction');
            assert.equal(headers['anthropic-beta'], 'tools');
            assert.equal(upstream.protocol, 'anthropic');
            return {body: Readable.from([Buffer.from('{"id":"msg_1"}')])};
        },
        callUpstream: async (upstream, invoke) => ({response: await invoke(upstream)}),
        getAnthropicRequestHeaders: (req) => req.headers,
        readResponseBody: async (body) => {
            const chunks = [];
            for await (const chunk of body) chunks.push(chunk);
            return Buffer.concat(chunks).toString('utf8');
        },
        anthropicResponseToChat: () => ({
            choices: [{message: {content: 'anthropic summary'}}],
            usage: {prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: {cached_tokens: 1}}
        }),
        recordUsage: (...args) => usageCalls.push(args),
        extractCacheHitTokens: (usage) => usage.prompt_tokens_details?.cached_tokens || 0
    });

    assert.equal(summary, 'anthropic summary');
    assert.deepEqual(usageCalls, [[42, 7, 3, 1, 'client-model@0']]);
});

test('compactRelayChatRequest saves compacted requests and logs the compaction', async () => {
    const saveCalls = [];
    const {messages, logger} = createLoggerRecorder();
    const compactedRequest = {model: 'gpt-5', messages: [{role: 'system', content: 'summary'}]};

    const result = await compactRelayChatRequest({
        chatRequest: {model: 'gpt-5', messages: [{role: 'user', content: 'history'}]},
        tenantId: 42,
        conversationKey: 'conv-1',
        requestType: 'ResponsesViaChat',
        compactChatRequestIfNeeded: async ({chatRequest, summarize, force, reason}) => {
            assert.equal(force, true);
            assert.equal(reason, 'manual');
            assert.equal(await summarize({summaryRequest: {model: chatRequest.model}}), 'summary text');
            return {
                compacted: true,
                chatRequest: compactedRequest,
                oldMessageCount: 8,
                recentMessageCount: 2,
                estimatedTokens: 200_000,
                compactedTokens: 20_000
            };
        },
        generateSummary: async ({summaryRequest}) => `${summaryRequest.model} summary text`.replace('gpt-5 ', ''),
        conversationStore: {
            saveChatRequest: (payload) => saveCalls.push(payload)
        },
        logger,
        force: true,
        reason: 'manual'
    });

    assert.equal(result.chatRequest, compactedRequest);
    assert.deepEqual(saveCalls, [{
        tenantId: 42,
        conversationKey: 'conv-1',
        request: compactedRequest
    }]);
    assert.deepEqual(messages, [[
        'info',
        'Relay context compacted (ResponsesViaChat): messages 8+2, tokens 200000->20000'
    ]]);
});

test('invokeWithRelayContextCompaction keeps original request when proactive compaction fails', async () => {
    const {messages, logger} = createLoggerRecorder();
    const originalRequest = {model: 'gpt-5', messages: [{role: 'user', content: 'history'}]};

    const result = await invokeWithRelayContextCompaction({
        chatRequest: originalRequest,
        compactOptions: {requestType: 'ResponsesViaChat'},
        compactRelayChatRequest: async () => {
            throw new Error('summary upstream failed');
        },
        isContextWindowExceededError: () => false,
        logger,
        invoke: async (readyChatRequest) => {
            assert.equal(readyChatRequest, originalRequest);
            return {ok: true};
        }
    });

    assert.deepEqual(result, {
        chatRequest: originalRequest,
        result: {ok: true},
        retriedAfterCompaction: false
    });
    assert.deepEqual(messages, [[
        'warn',
        'Relay context proactive compaction skipped: summary upstream failed'
    ]]);
});

test('invokeWithRelayContextCompaction force compacts and retries context-window failures', async () => {
    const {messages, logger} = createLoggerRecorder();
    const originalRequest = {model: 'gpt-5', messages: [{role: 'user', content: 'history'}]};
    const proactiveRequest = {model: 'gpt-5', messages: [{role: 'user', content: 'still huge'}]};
    const forcedRequest = {model: 'gpt-5', messages: [{role: 'system', content: 'summary'}]};
    const compactCalls = [];
    let invokeCount = 0;

    const result = await invokeWithRelayContextCompaction({
        chatRequest: originalRequest,
        compactOptions: {requestType: 'ResponsesViaChat'},
        compactRelayChatRequest: async (options) => {
            compactCalls.push({
                chatRequest: options.chatRequest,
                force: options.force,
                reason: options.reason
            });
            if (options.force) {
                return {compacted: true, chatRequest: forcedRequest};
            }
            return {compacted: true, chatRequest: proactiveRequest};
        },
        isContextWindowExceededError: (error) => error.code === 400,
        logger,
        invoke: async (readyChatRequest) => {
            invokeCount += 1;
            if (invokeCount === 1) {
                assert.equal(readyChatRequest, proactiveRequest);
                throw Object.assign(new Error('context window exceeded'), {code: 400});
            }
            assert.equal(readyChatRequest, forcedRequest);
            return {ok: true};
        }
    });

    assert.deepEqual(compactCalls, [
        {chatRequest: originalRequest, force: false, reason: undefined},
        {chatRequest: proactiveRequest, force: true, reason: 'context-window-exceeded'}
    ]);
    assert.deepEqual(result, {
        chatRequest: forcedRequest,
        result: {ok: true},
        retriedAfterCompaction: true
    });
    assert.deepEqual(messages, [[
        'warn',
        'Relay context exceeded, compacting and retrying once: context window exceeded'
    ]]);
});

test('createRelayContextCompaction binds dependencies for route usage', async () => {
    const compactCalls = [];
    const {invokeWithRelayContextCompaction: invokeWithBoundCompaction} = createRelayContextCompaction({
        compactChatRequestIfNeeded: async ({chatRequest}) => {
            compactCalls.push(chatRequest);
            return {compacted: false, chatRequest};
        },
        conversationStore: {saveChatRequest: () => {}},
        logger: createLoggerRecorder().logger,
        isContextWindowExceededError: () => false
    });
    const chatRequest = {model: 'gpt-5', messages: []};

    const result = await invokeWithBoundCompaction({
        chatRequest,
        compactOptions: {requestType: 'ResponsesViaChat'},
        invoke: async (readyChatRequest) => ({readyChatRequest})
    });

    assert.equal(result.result.readyChatRequest, chatRequest);
    assert.deepEqual(compactCalls, [chatRequest]);
});
