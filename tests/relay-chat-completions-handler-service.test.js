import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayChatCompletionsHandler} from '../src/services/relay/protocols/chat/completions.js';

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

test('handleOpenAIChatCompletions passes request signal to Anthropic streaming bridge', async () => {
    const controller = new AbortController();
    const res = {
        calls: [],
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        writeHead: (...args) => res.calls.push(['writeHead', args]),
        write: (chunk) => res.calls.push(['write', chunk]),
        end: () => res.calls.push(['end'])
    };
    let seenSignal = null;
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'gpt-test',
            messages: [{role: 'user', content: 'hello'}],
            stream: true
        }),
        isAnthropicUpstream: () => true,
        chatRequestToAnthropic: (payload) => payload,
        getAnthropicRequestHeaders: () => ({}),
        createAnthropicMessages: (payload) => payload,
        callUpstream: async () => ({response: {body: {}}}),
        createChatStreamAccumulator: () => ({
            feed: () => {},
            toChatResponse: () => null
        }),
        streamAnthropicSSEToChatChunks: async function* (_body, _parseSSEBlock, signal) {
            seenSignal = signal;
            yield {id: 'chunk_1', choices: [], usage: {prompt_tokens: 1, completion_tokens: 2}};
        },
        parseSSEBlock: () => {},
        extractCacheHitTokens: () => 0
    });
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}, signal: controller.signal}, res);

    assert.equal(seenSignal, controller.signal);
});

test('handleOpenAIChatCompletions disables Responses WS auto-link after continuation mismatch', async () => {
    const res = createResponse();
    let capturedMeta = null;
    const deps = createBaseDeps({
        isResponsesWebSocketUpstream: () => true,
        chatRequestToRelayResponses: (payload) => ({
            model: payload.model,
            input: [{role: 'user', content: 'hello'}]
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
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(capturedMeta.autoLink, false);
    assert.deepEqual(res.calls, [['json', 200, {id: 'chat_from_resp_1'}]]);
});

test('handleOpenAIChatCompletions disables Responses WS continuation when upstream opts out', async () => {
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
            previous_response_id: 'resp_prev'
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
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(capturedContinuationOptions.disableContinuation, true);
    assert.equal(capturedMeta.autoLink, false);
    assert.equal(capturedMeta.skipInputItemLimit, true);
    assert.deepEqual(res.calls, [['json', 200, {id: 'chat_from_resp_1'}]]);
});

test('handleOpenAIChatCompletions applies continuation before HTTP Responses upstream', async () => {
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
        extractInputTokens: (usage) => usage?.input_tokens || 0,
        recordCompletedResponseState: (...args) => deps.calls.push(['recordCompletedResponseState', args]),
        recordResponsesUsage: (...args) => deps.calls.push(['recordResponsesUsage', args]),
        callUpstream: async (upstream, invoke) => {
            deps.calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: '{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}'}};
        }
    });
    const handleOpenAIChatCompletions = createRelayChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(capturedContinuationOptions.requestType, 'ChatCompletionsViaResponses');
    assert.deepEqual(capturedCreatePayload.input, [{role: 'user', content: 'latest'}]);
    assert.equal(capturedCreatePayload.previous_response_id, 'resp_prev');
    assert.equal(capturedCreateMeta.conversationKey, 'tenant:42:conv');
    assert.deepEqual(res.calls, [['json', 200, {id: 'chat_from_resp_1'}]]);
});
