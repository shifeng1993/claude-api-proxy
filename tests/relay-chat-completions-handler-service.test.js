import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayChatCompletionsHandler} from '../src/services/relay/chat-completions-handler.js';

function createResponse() {
    return {calls: [], headersSent: false, destroyed: false, writableEnded: false};
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
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        sendStateMissingOpenAIError: (res, error) => res.calls.push(['state-missing', error.message]),
        sendResponsesWebSocketProtocolError: (res, error) => res.calls.push(['ws-error', error.message]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        injectBehaviorRules: (messages) => [...messages, {role: 'system', content: 'rule'}],
        stripDynamicReminders: (messages) => messages.filter((message) => message.content !== 'drop'),
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
            const response = {body: '{"id":"chatcmpl_1","usage":{"prompt_tokens":5,"completion_tokens":7}}'};
            calls.push(['callUpstream', invoke(upstream)]);
            return {response};
        },
        createChatCompletions: (payload, upstream, meta) => ({payload, upstream, meta}),
        readResponseBody: async (body) => body,
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        logger: {error: (...args) => calls.push(['logError', args]), warn: (...args) => calls.push(['logWarn', args])},
        RelayStateMissingError: class RelayStateMissingError extends Error {},
        isResponsesWebSocketProtocolError: () => false,
        ...overrides
    };
    return deps;
}

test('handleOpenAIChatCompletions returns OpenAI auth errors without reading the body', async () => {
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
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', 'authentication_error']]);
});

test('handleOpenAIChatCompletions records non-stream Chat passthrough responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[0][1], 200);
    assert.equal(res.calls[0][2].id, 'chatcmpl_1');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 'gpt-test-resolved']
    );
    assert.equal(deps.calls.some((call) => call[0] === 'saveChatRequest'), true);
    assert.equal(deps.calls.some((call) => call[0] === 'recordChatResponse'), true);
});
