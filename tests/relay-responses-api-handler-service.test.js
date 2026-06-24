import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesAPIHandler} from '../src/services/relay/responses-api-handler.js';

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
        sendStateMissingOpenAIError: (res, error) => res.calls.push(['state-missing', error.message]),
        sendResponsesWebSocketProtocolError: (res, error) => res.calls.push(['ws-error', error.message]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            input: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        isAnthropicUpstream: () => false,
        isResponsesWebSocketUpstream: () => false,
        isResponsesUpstream: () => false,
        extractConversationKey: () => 'tenant:42:conv',
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: [{role: 'user', content: 'hello'}]},
                conversationKey
            })
        },
        tenantDirectory: {
            getTenant: async () => ({name: 'Tenant', username: 'alice'})
        },
        invokeWithRelayContextCompaction: async ({chatRequest, invoke}) => ({
            chatRequest,
            result: await invoke(chatRequest)
        }),
        callUpstream: async (upstream, invoke) => {
            calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: 'stream-body'}};
        },
        prepareRelayOutboundChatRequest: (request, options) => ({...request, ...options}),
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
        chatResponseToRelayResponses: (response) => ({id: 'resp_1', source: response.id, usage: response.usage}),
        recordCompletedResponseState: (...args) => calls.push(['recordCompletedResponseState', args]),
        RelayStateMissingError: class RelayStateMissingError extends Error {},
        isResponsesWebSocketProtocolError: () => false,
        logger: {error: (...args) => calls.push(['logError', args]), warn: (...args) => calls.push(['logWarn', args])},
        ...overrides
    };
    return deps;
}

test('handleResponsesAPI returns OpenAI auth errors without reading the body', async () => {
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
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesAPI aggregates non-stream Chat upstream responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.deepEqual(res.calls, [['json', 200, {
        id: 'resp_1',
        source: 'chatcmpl_1',
        usage: {prompt_tokens: 5, completion_tokens: 7, total_tokens: 12}
    }]]);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 'gpt-test-resolved']
    );
    assert.equal(deps.calls.some((call) => call[0] === 'recordCompletedResponseState'), true);
});
