import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayAnthropicMessagesHandler} from '../src/services/relay/protocols/anthropic/messages.js';

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

test('handleAnthropicMessages disables Responses WS auto-link after continuation mismatch', async () => {
    const res = createResponse();
    let capturedMeta = null;
    const deps = createBaseDeps({
        isResponsesWebSocketUpstream: () => true,
        chatRequestToRelayResponses: (payload) => ({
            model: payload.model,
            input: [{role: 'user', content: 'hello'}],
            stream: payload.stream
        }),
        prepareResponsesContinuationPayload: ({request, conversationKey}) => ({
            request,
            conversationKey,
            deltaAttempted: true,
            deltaApplied: false,
            autoLink: false
        }),
        createResponsesWebSocket: (payload, upstream, meta) => {
            capturedMeta = meta;
            return {payload, upstream};
        },
        collectResponsesWebSocketResponse: async () => ({
            id: 'resp_1',
            usage: {input_tokens: 1, output_tokens: 2}
        }),
        recordCompletedResponseState: (...args) => deps.calls.push(['recordCompletedResponseState', args]),
        recordResponsesUsage: (...args) => deps.calls.push(['recordResponsesUsage', args]),
        responsesResponseToRelayChat: (response) => ({id: `chat_from_${response.id}`})
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.equal(capturedMeta.autoLink, false);
    assert.deepEqual(res.calls, [['json', 200, {type: 'message', source: 'chat_from_resp_1'}]]);
});

test('handleAnthropicMessages preserves signed thinking when forwarding through Responses WS', async () => {
    const res = createResponse();
    let capturedCreatePayload = null;
    let directConverterCalled = false;
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'claude-test',
            stream: false,
            messages: [
                {role: 'user', content: [{type: 'text', text: 'Read README\nLast active: today'}]},
                {
                    role: 'assistant',
                    content: [
                        {type: 'thinking', thinking: 'Need file.', signature: 'sig_1'},
                        {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
                    ]
                },
                {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: 'README text'}]}
            ]
        }),
        isResponsesWebSocketUpstream: () => true,
        chatRequestToRelayResponses: () => {
            throw new Error('signed thinking must not be bridged through Chat');
        },
        anthropicRequestToResponses: (payload) => {
            directConverterCalled = true;
            assert.equal(payload.system, 'rule');
            assert.deepEqual(payload.messages[0], {
                role: 'user',
                content: [{type: 'text', text: 'Read README\n'}]
            });
            return {
                model: payload.model,
                stream: payload.stream,
                input: [
                    {role: 'user', content: [{type: 'input_text', text: 'Read README'}]},
                    {
                        type: 'reasoning',
                        summary: [{type: 'summary_text', text: 'Need file.'}],
                        x_relay_anthropic_thinking: [
                            {type: 'thinking', thinking: 'Need file.', signature: 'sig_1'}
                        ]
                    },
                    {type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"README.md"}'},
                    {type: 'function_call_output', call_id: 'toolu_1', output: 'README text'}
                ]
            };
        },
        prepareResponsesContinuationPayload: ({request, conversationKey}) => ({
            request,
            conversationKey,
            deltaAttempted: false,
            deltaApplied: false,
            autoLink: false
        }),
        createResponsesWebSocket: (payload, upstream, meta) => {
            capturedCreatePayload = payload;
            return {payload, upstream, meta};
        },
        collectResponsesWebSocketResponse: async () => ({
            id: 'resp_1',
            usage: {input_tokens: 1, output_tokens: 2}
        }),
        recordCompletedResponseState: (...args) => deps.calls.push(['recordCompletedResponseState', args]),
        recordResponsesUsage: (...args) => deps.calls.push(['recordResponsesUsage', args]),
        responsesResponseToRelayChat: (response) => ({id: `chat_from_${response.id}`})
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.equal(directConverterCalled, true);
    assert.deepEqual(
        capturedCreatePayload.input[1].x_relay_anthropic_thinking,
        [{type: 'thinking', thinking: 'Need file.', signature: 'sig_1'}]
    );
    assert.deepEqual(res.calls, [['json', 200, {type: 'message', source: 'chat_from_resp_1'}]]);
});

test('handleAnthropicMessages disables Responses WS continuation when upstream opts out', async () => {
    const res = createResponse();
    let capturedContinuationOptions = null;
    let capturedMeta = null;
    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            upstream: {index: 0, disable_responses_continuation: true},
            tenantId: 42,
            upstreamManager: {
                resolveModel: (model) => `${model}-resolved`
            }
        }),
        isResponsesWebSocketUpstream: () => true,
        chatRequestToRelayResponses: (payload) => ({
            model: payload.model,
            input: [
                {role: 'user', content: 'hello'},
                {role: 'assistant', content: 'hi'},
                {role: 'user', content: 'again'}
            ],
            previous_response_id: 'resp_prev',
            stream: payload.stream
        }),
        prepareResponsesContinuationPayload: (options) => {
            capturedContinuationOptions = options;
            return {
                request: {
                    ...options.request,
                    previous_response_id: undefined
                },
                conversationKey: options.conversationKey,
                deltaAttempted: false,
                deltaApplied: false,
                autoLink: false
            };
        },
        createResponsesWebSocket: (payload, upstream, meta) => {
            capturedMeta = meta;
            return {payload, upstream};
        },
        collectResponsesWebSocketResponse: async () => ({
            id: 'resp_1',
            usage: {input_tokens: 1, output_tokens: 2}
        }),
        recordCompletedResponseState: (...args) => deps.calls.push(['recordCompletedResponseState', args]),
        recordResponsesUsage: (...args) => deps.calls.push(['recordResponsesUsage', args]),
        responsesResponseToRelayChat: (response) => ({id: `chat_from_${response.id}`})
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.equal(capturedContinuationOptions.disableContinuation, true);
    assert.equal(capturedMeta.autoLink, false);
    assert.equal(capturedMeta.skipInputItemLimit, true);
    assert.deepEqual(res.calls, [['json', 200, {type: 'message', source: 'chat_from_resp_1'}]]);
});

test('handleAnthropicMessages applies continuation before HTTP Responses upstream', async () => {
    const res = createResponse();
    let capturedContinuationOptions = null;
    let capturedCreatePayload = null;
    let capturedCreateMeta = null;
    const deps = createBaseDeps({
        isResponsesUpstream: () => true,
        chatRequestToRelayResponses: (payload) => ({
            model: payload.model,
            input: [
                {role: 'user', content: 'old'},
                {role: 'assistant', content: 'answer'},
                {role: 'user', content: 'latest'}
            ],
            stream: payload.stream
        }),
        prepareResponsesContinuationPayload: (options) => {
            capturedContinuationOptions = options;
            return {
                request: {
                    ...options.request,
                    input: [{role: 'user', content: 'latest'}],
                    previous_response_id: 'resp_prev'
                },
                conversationKey: 'tenant:42:conv',
                autoLink: true,
                skipInputItemLimit: false
            };
        },
        createResponses: (payload, upstream, meta) => {
            capturedCreatePayload = payload;
            capturedCreateMeta = meta;
            return {payload, upstream, meta};
        },
        responsesResponseToRelayChat: (response) => ({id: `chat_from_${response.id}`}),
        recordCompletedResponseState: (...args) => deps.calls.push(['recordCompletedResponseState', args]),
        recordResponsesUsage: (...args) => deps.calls.push(['recordResponsesUsage', args]),
        readResponseBody: async (body) => body,
        callUpstream: async (upstream, invoke) => {
            deps.calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: '{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}'}};
        }
    });
    const handleAnthropicMessages = createRelayAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.equal(capturedContinuationOptions.requestType, 'AnthropicViaResponses');
    assert.deepEqual(capturedCreatePayload.input, [{role: 'user', content: 'latest'}]);
    assert.equal(capturedCreatePayload.previous_response_id, 'resp_prev');
    assert.equal(capturedCreateMeta.conversationKey, 'tenant:42:conv');
    assert.deepEqual(res.calls, [['json', 200, {type: 'message', source: 'chat_from_resp_1'}]]);
});
