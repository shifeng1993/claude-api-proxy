import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesWebSocketHandler} from '../src/services/relay/responses-websocket-handler.js';

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
