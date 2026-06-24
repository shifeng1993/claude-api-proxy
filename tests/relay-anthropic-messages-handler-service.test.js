import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayAnthropicMessagesHandler} from '../src/services/relay/anthropic-messages-handler.js';

function createResponse() {
    return {calls: [], headersSent: false};
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const deps = {
        calls,
        authenticateAndGetUpstream: async () => ({
            upstream: {index: 0},
            tenantId: 42,
            upstreamManager: {
                resolveModel: (model) => `${model}-resolved`
            }
        }),
        tenantDirectory: {
            getTenant: async () => ({name: 'Tenant', username: 'alice'})
        },
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'claude-test',
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        sanitizeAnthropicPayload: (payload) => ({...payload, sanitized: true}),
        anthropicToOpenAI: (payload, model) => ({
            model,
            messages: payload.messages.map((message) => ({role: message.role, content: message.content})),
            stream: payload.stream
        }),
        injectBehaviorRules: (messages) => [...messages, {role: 'system', content: 'rule'}],
        stripDynamicReminders: (messages) => messages,
        mergeConsecutiveAssistantMessages: (messages) => calls.push(['merge', messages.length]),
        extractConversationKey: () => 'tenant:42:conv',
        relayConversationStore: {
            saveChatRequest: (payload) => calls.push(['saveChatRequest', payload]),
            recordChatResponse: (payload) => calls.push(['recordChatResponse', payload])
        },
        isAnthropicUpstream: () => false,
        isResponsesWebSocketUpstream: () => false,
        isResponsesUpstream: () => false,
        callUpstream: async (upstream, invoke) => {
            calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: 'stream-body'}};
        },
        createChatCompletions: (payload, upstream, meta) => ({payload, upstream, meta}),
        aggregateStreamResponse: async () => ({
            id: 'chatcmpl_1',
            model: 'gpt-test',
            content: 'hello back',
            reasoningContent: 'thinking',
            toolCalls: [],
            finishReason: 'stop',
            usage: {prompt_tokens: 5, completion_tokens: 7, total_tokens: 12}
        }),
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        chatResponseToAnthropic: (response) => ({type: 'message', source: response.id}),
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
    return deps;
}

test('handleAnthropicMessages returns Anthropic auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            error: {status: 401, message: 'Unauthorized'}
        }),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['anthropic-error', 401, 'Unauthorized']]);
});

test('handleAnthropicMessages aggregates non-stream Chat upstream responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.deepEqual(res.calls, [['json', 200, {type: 'message', source: 'chatcmpl_1'}]]);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 'claude-test-resolved']
    );
    assert.equal(deps.calls.some((call) => call[0] === 'saveChatRequest'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'recordChatResponse'), true);
});
