import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesWebSocketHandler} from '../src/services/relay/responses-websocket-handler.js';
import {RelayConversationStore} from '../src/services/session/conversation-state.js';

async function collect(iterable) {
    const events = [];
    for await (const event of iterable) {
        events.push(event);
    }
    return events;
}

async function* chunks(...items) {
    for (const item of items) {
        yield Buffer.from(item);
    }
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    let capturedOptions = null;
    const deps = {
        calls,
        get capturedOptions() {
            return capturedOptions;
        },
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
        handleWSConnection: (clientWs, options) => {
            calls.push(['handleWSConnection', clientWs]);
            capturedOptions = options;
        },
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        extractConversationKey: () => 'tenant:42:ws',
        isAnthropicUpstream: () => false,
        isResponsesWebSocketUpstream: () => false,
        isResponsesUpstream: () => false,
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: [{role: 'user', content: 'hello'}]},
                conversationKey
            }),
            prepareResponsesPassthrough: ({request, conversationKey}) => ({
                request,
                conversationKey,
                lastResponseId: 'resp_prev'
            })
        },
        RelayStateMissingError: class RelayStateMissingError extends Error {},
        toResponsesWebSocketStateMissingError: (error) => Object.assign(new Error(error.message), {name: 'ResponsesWebSocketError'}),
        invokeWithRelayContextCompaction: async ({chatRequest, invoke}) => ({
            chatRequest,
            result: await invoke(chatRequest)
        }),
        prepareRelayOutboundChatRequest: (request, options) => ({...request, ...options}),
        callUpstream: async (upstream, invoke) => {
            calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: chunks('data: {"id":"chunk_1"}\n\n')}};
        },
        createChatCompletions: (payload, upstream, meta) => ({payload, upstream, meta}),
        createChatToResponsesStreamBridge: () => ({
            feed: (chunk) => [{
                event: 'response.completed',
                data: {response: {id: `resp_from_${chunk.id}`, usage: {input_tokens: 3, output_tokens: 4}}}
            }]
        }),
        createResponsesStreamAccumulator: () => ({
            feed: (...args) => calls.push(['responsesAccumulator.feed', args]),
            toResponsesResponse: () => ({id: 'resp_accumulated'})
        }),
        recordCompletedResponseState: (...args) => calls.push(['recordCompletedResponseState', args]),
        ...overrides
    };
    return deps;
}

test('handleRelayResponsesWS maps upstream auth failures into Responses WebSocket errors', async () => {
    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            error: {status: 503, message: 'No upstream'}
        })
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);

    await assert.rejects(
        () => collect(deps.capturedOptions.handleRequest({model: 'gpt-test'}, null, {signal: {aborted: false}})),
        (error) => {
            assert.equal(error.name, 'ResponsesWebSocketError');
            assert.equal(error.event.error.code, 'no_upstream');
            assert.equal(error.event.error.message, 'No upstream');
            return true;
        }
    );
});

test('handleRelayResponsesWS bridges Chat upstream chunks into Responses WebSocket events', async () => {
    const deps = createBaseDeps();
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({model: 'gpt-test'}, null, {signal: {aborted: false}}));

    assert.deepEqual(events, [{
        type: 'response.completed',
        data: {response: {id: 'resp_from_chunk_1', usage: {input_tokens: 3, output_tokens: 4}}}
    }]);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordCompletedResponseState')?.[1],
        [42, 'tenant:42:ws', {id: 'resp_from_chunk_1', usage: {input_tokens: 3, output_tokens: 4}}]
    );
    assert.equal(req.relayResolvedModel, 'gpt-test-resolved');
});

test('handleRelayResponsesWS passes native Responses continuation payload through unchanged', async () => {
    let capturedResponsesPayload = null;
    const deps = createBaseDeps({
        isResponsesUpstream: () => true,
        limitResponsesPassthroughPayload: (request) => request,
        createResponses: (payload) => {
            capturedResponsesPayload = payload;
            return {payload};
        },
        callUpstream: async (upstream, invoke) => {
            deps.calls.push(['callUpstream', invoke(upstream)]);
            return {
                response: {
                    body: chunks(
                        'event: response.completed\n'
                        + 'data: {"type":"response.completed","response":{"id":"resp_native","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
                    )
                }
            };
        },
        parseSSEBlock: (part) => {
            const lines = part.split(/\r?\n/);
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            return {event, data};
        },
        getSSEEventType: (event, parsed) => event || parsed?.type
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        previous_response_id: 'resp_prev',
        input: [{type: 'function_call_output', call_id: 'call_1', output: 'tool result'}],
        store: false
    }, null, {signal: {aborted: false}}));

    assert.equal(capturedResponsesPayload.model, 'gpt-test-resolved');
    assert.equal(capturedResponsesPayload.previous_response_id, 'resp_prev');
    assert.deepEqual(capturedResponsesPayload.input, [
        {type: 'function_call_output', call_id: 'call_1', output: 'tool result'}
    ]);
    assert.equal(capturedResponsesPayload.store, false);
    assert.deepEqual(events, [{
        type: 'response.completed',
        data: {
            type: 'response.completed',
            response: {id: 'resp_native', usage: {input_tokens: 1, output_tokens: 2}}
        }
    }]);
});

test('handleRelayResponsesWS hydrates tool-result deltas before Anthropic fallback conversion', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 42;
    const conversationKey = 'tenant:42:ws';
    let capturedChatPayload = null;

    store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'gpt-test-resolved',
            input: [{role: 'user', content: [{type: 'input_text', text: 'read file'}]}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_tool_call',
            model: 'gpt-test-resolved',
            output: [{
                type: 'function_call',
                call_id: 'call_read',
                name: 'Read',
                arguments: '{"file_path":"src/index.js"}'
            }]
        }
    });

    try {
        const deps = createBaseDeps({
            isAnthropicUpstream: () => true,
            relayConversationStore: store,
            chatRequestToAnthropic: (payload) => {
                capturedChatPayload = payload;
                return {messages: payload.messages, stream: payload.stream};
            },
            createAnthropicMessages: (payload, upstream, meta) => ({payload, upstream, meta}),
            getAnthropicRequestHeaders: () => ({}),
            createChatStreamAccumulator: () => ({
                feed: () => {},
                toChatResponse: () => ({choices: [{message: {role: 'assistant', content: 'ok'}}]})
            }),
            streamAnthropicSSEToChatChunks: async function* () {
                yield {id: 'chunk_1'};
            },
            canonicalFromAnthropicStreamChatResponse: () => null
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId};

        await handleRelayResponsesWS({id: 'client'}, req);
        await collect(deps.capturedOptions.handleRequest({
            model: 'gpt-test',
            previous_response_id: 'resp_tool_call',
            input: [
                {type: 'function_call_output', call_id: 'call_read', output: 'file contents'},
                {role: 'assistant', content: [{type: 'output_text', text: 'reminder'}]}
            ]
        }, null, {signal: {aborted: false}}));

        assert.deepEqual(
            capturedChatPayload.messages.map((message) => message.role),
            ['user', 'assistant', 'tool', 'assistant']
        );
        assert.equal(capturedChatPayload.messages[1].tool_calls[0].id, 'call_read');
        assert.equal(capturedChatPayload.messages[2].tool_call_id, 'call_read');
    } finally {
        store.dispose();
    }
});
