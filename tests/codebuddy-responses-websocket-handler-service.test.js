import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyResponsesWebSocketHandler} from '../src/services/codebuddy/protocols/responses/websocket.js';
import {mapCodebuddyModelName} from '../src/services/codebuddy/model-mapping.js';

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
        handleWSConnection: (clientWs, options) => {
            calls.push(['handleWSConnection', clientWs]);
            capturedOptions = options;
        },
        resolveCredentialContext: async () => ({
            credential: {id: 'cred-1', enterprise_id: 'ent-1', base_url: 'https://codebuddy.example.com'},
            tenantId: 42
        }),
        tenantManager: {
            getTenant: () => ({name: 'Tenant', username: 'alice'})
        },
        getCodebuddyBaseUrl: (baseUrl) => baseUrl,
        isPersonalHost: () => false,
        resolveConversationId: (...args) => {
            calls.push(['resolveConversationId', args]);
            return 'conv-ws';
        },
        responsesRequestToChat: (payload) => ({
            model: payload.model,
            messages: [{role: 'user', content: 'hello'}],
            stream: payload.stream
        }),
        mapModelName: mapCodebuddyModelName,
        prepareCodebuddyOutboundChatRequest: (payload) => {
            calls.push(['prepare', payload]);
            return payload;
        },
        createChatCompletions: async (payload, context) => {
            calls.push(['createChatCompletions', payload, context]);
            return {body: chunks('data: {"id":"chunk_1"}\n\n')};
        },
        createChatToResponsesStreamBridge: () => ({
            finished: false,
            feed(data) {
                calls.push(['bridgeFeed', data]);
                return [{
                    event: 'response.completed',
                    data: {response: {id: `resp_from_${data.id}`}}
                }];
            },
            finish() {
                this.finished = true;
                calls.push(['bridgeFinish']);
                return [];
            }
        }),
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        logger: {warn: (...args) => calls.push(['logWarn', args])},
        ...overrides
    };
    return deps;
}

test('handleCodebuddyResponsesWS maps missing credentials to Responses WebSocket errors', async () => {
    const deps = createBaseDeps({
        resolveCredentialContext: async () => ({
            error: {status: 503, message: 'No available credentials for tenant'}
        })
    });
    const handleCodebuddyResponsesWS = createCodebuddyResponsesWebSocketHandler(deps);
    const req = {tenantId: 42, headers: {}};

    handleCodebuddyResponsesWS({id: 'client'}, req);

    await assert.rejects(
        () => collect(deps.capturedOptions.handleRequest({model: 'gpt-4o'}, null, {signal: {aborted: false}})),
        (error) => {
            assert.equal(error.name, 'ResponsesWebSocketError');
            assert.equal(error.event.error.code, 'no_credentials');
            assert.equal(error.event.error.message, 'No available credentials for tenant');
            return true;
        }
    );
});

test('handleCodebuddyResponsesWS bridges Chat upstream chunks into Responses WebSocket events', async () => {
    const deps = createBaseDeps();
    const handleCodebuddyResponsesWS = createCodebuddyResponsesWebSocketHandler(deps);
    const req = {tenantId: 42, headers: {'x-request-id': 'trace-1'}};

    handleCodebuddyResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-4o',
        input: [{role: 'user', content: 'hello'}]
    }, null, {signal: {aborted: false}}));

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[1].model, 'deepseek-v4-flash');
    assert.equal(createCall[1].stream, true);
    assert.equal(createCall[2].conversationId, 'conv-ws');
    assert.deepEqual(events, [{
        type: 'response.completed',
        data: {response: {id: 'resp_from_chunk_1'}}
    }]);
    assert.equal(Boolean(req.codebuddyClientConnectionId), true);

    deps.capturedOptions.onUsage(3, 4, 2, 'model-from-ws');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 3, 4, 2, 0, 'model-from-ws', 'model-from-ws']
    );
});
