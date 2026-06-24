import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesCompactHandler} from '../src/services/relay/responses-compact-handler.js';

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
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        sendResponsesWebSocketProtocolError: (res, error) => res.calls.push(['ws-error', error.message]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            input: [{role: 'user', content: 'compact me'}]
        }),
        isAnthropicUpstream: () => false,
        isResponsesWebSocketUpstream: () => false,
        isResponsesUpstream: () => false,
        extractConversationKey: () => 'tenant:42:compact',
        tenantDirectory: {
            getTenant: async () => ({name: 'Tenant', username: 'alice'})
        },
        compactRequestToChat: (request) => ({
            model: request.model,
            messages: [{role: 'user', content: 'compact me'}]
        }),
        injectBehaviorRules: (messages) => messages,
        stripDynamicReminders: (messages) => messages,
        mergeConsecutiveAssistantMessages: (messages) => calls.push(['mergeConsecutiveAssistantMessages', messages]),
        callUpstream: async (upstream, invoke) => {
            calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: 'stream-body'}};
        },
        createChatCompletions: (payload, upstream, meta) => ({payload, upstream, meta}),
        aggregateStreamResponse: async () => ({
            id: 'chatcmpl_1',
            model: 'gpt-test',
            content: 'compacted answer',
            finishReason: 'stop',
            usage: {prompt_tokens: 5, completion_tokens: 7, total_tokens: 12}
        }),
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        chatResponseToCompact: (response) => ({compact: true, source: response.id, usage: response.usage}),
        isResponsesWebSocketProtocolError: () => false,
        logger: {error: (...args) => calls.push(['logError', args]), warn: (...args) => calls.push(['logWarn', args])},
        ...overrides
    };
    return deps;
}

test('handleResponsesCompact returns OpenAI auth errors without reading the body', async () => {
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
    const handleResponsesCompact = createRelayResponsesCompactHandler(deps);

    await handleResponsesCompact({}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesCompact aggregates Chat upstream streams into compact responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleResponsesCompact = createRelayResponsesCompactHandler(deps);

    await handleResponsesCompact({headers: {}}, res);

    assert.deepEqual(res.calls, [['json', 200, {
        compact: true,
        source: 'chatcmpl_1',
        usage: {prompt_tokens: 5, completion_tokens: 7, total_tokens: 12}
    }]]);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 'gpt-test-resolved']
    );
    assert.equal(deps.calls.some((call) => call[0] === 'mergeConsecutiveAssistantMessages'), true);
});
