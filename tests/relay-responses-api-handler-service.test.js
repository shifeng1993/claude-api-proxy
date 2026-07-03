import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesAPIHandler} from '../src/services/relay/protocols/responses/http.js';
import {RelayConversationStore} from '../src/services/session/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../src/services/session/responses-continuation.js';

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
        prepareResponsesContinuationPayload,
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

test('handleResponsesAPI maps invalid upstream JSON to 502', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        isAnthropicUpstream: () => true,
        chatRequestToAnthropic: (payload) => payload,
        createAnthropicMessages: (payload) => payload,
        getAnthropicRequestHeaders: () => ({}),
        readResponseBody: async () => 'not-json'
    });
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.deepEqual(res.calls, [[
        'openai-error',
        502,
        'Upstream returned invalid JSON',
        undefined
    ]]);
});

test('handleResponsesAPI deltas visible full history before forwarding to Responses upstream', async () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 800,
        maxCanonicalTurns: 800
    });
    const tenantId = 42;
    const conversationKey = 'tenant:42:conv';
    let capturedResponsesPayload = null;

    try {
        const previousMessages = Array.from({length: 600}, (_, index) => ({
            role: 'user',
            content: `question ${index}`
        }));
        store.saveChatRequest({
            tenantId,
            conversationKey,
            request: {model: 'gpt-test-resolved', messages: previousMessages}
        });
        store.recordResponsesResponse({
            tenantId,
            conversationKey,
            response: {
                id: 'resp_1',
                model: 'gpt-test-resolved',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'previous answer'}]
                }]
            }
        });

        const fullHistoryInput = [
            ...previousMessages.map((message) => ({
                role: 'user',
                content: [{type: 'input_text', text: message.content}]
            })),
            {role: 'assistant', content: [{type: 'output_text', text: 'previous answer'}]},
            {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
        ];
        const deps = createBaseDeps({
            isResponsesUpstream: () => true,
            relayConversationStore: store,
            parseBody: async () => JSON.stringify({
                model: 'gpt-test',
                input: fullHistoryInput,
                stream: false
            }),
            createResponses: (payload) => {
                capturedResponsesPayload = payload;
                return {payload};
            },
            callUpstream: async (upstream, invoke) => {
                deps.calls.push(['callUpstream', invoke(upstream)]);
                return {
                    response: {
                        body: '{"id":"resp_2","usage":{"input_tokens":1,"output_tokens":2}}'
                    }
                };
            },
            readResponseBody: async (body) => body,
            extractInputTokens: (usage) => usage?.input_tokens || 0
        });
        const handleResponsesAPI = createRelayResponsesAPIHandler(deps);
        const res = createResponse();

        await handleResponsesAPI({headers: {}}, res);

        assert.equal(capturedResponsesPayload.previous_response_id, 'resp_1');
        assert.deepEqual(capturedResponsesPayload.input, [
            {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
        ]);
        assert.deepEqual(res.calls[0], [
            'json',
            200,
            {id: 'resp_2', usage: {input_tokens: 1, output_tokens: 2}}
        ]);
    } finally {
        store.dispose();
    }
});

test('handleResponsesAPI rejects empty Chat fallback without calling upstream', async () => {
    const res = createResponse();
    const RelayStateMissingError = class RelayStateMissingError extends Error {};
    const deps = createBaseDeps({
        RelayStateMissingError,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            input: [],
            stream: false
        }),
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: []},
                conversationKey
            })
        },
        callUpstream: async () => {
            assert.fail('empty Responses input should not be sent to Chat upstream');
        }
    });
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0][0], 'state-missing');
});

test('handleResponsesAPI rejects system-only Chat fallback without calling upstream', async () => {
    const res = createResponse();
    const RelayStateMissingError = class RelayStateMissingError extends Error {};
    const deps = createBaseDeps({
        RelayStateMissingError,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            input: [],
            stream: false
        }),
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: [{role: 'system', content: 'relay rules'}]},
                conversationKey
            })
        },
        callUpstream: async () => {
            assert.fail('system-only Responses input should not be sent to Chat upstream');
        }
    });
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0][0], 'state-missing');
});

test('handleResponsesAPI rejects empty Anthropic fallback without calling upstream', async () => {
    const res = createResponse();
    const RelayStateMissingError = class RelayStateMissingError extends Error {};
    const deps = createBaseDeps({
        RelayStateMissingError,
        isAnthropicUpstream: () => true,
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            input: [],
            stream: false
        }),
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: []},
                conversationKey
            })
        },
        chatRequestToAnthropic: (payload) => ({messages: payload.messages, stream: payload.stream}),
        callUpstream: async () => {
            assert.fail('empty Responses input should not be sent to Anthropic upstream');
        }
    });
    const handleResponsesAPI = createRelayResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0][0], 'state-missing');
});
