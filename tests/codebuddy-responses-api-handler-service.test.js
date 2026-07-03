import {PassThrough} from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyResponsesAPIHandler} from '../src/services/codebuddy/protocols/responses/http.js';
import {mapCodebuddyModelName} from '../src/services/codebuddy/model-mapping.js';

function createResponse() {
    let resolveEnd;
    return {
        calls: [],
        headersSent: false,
        ended: new Promise((resolve) => {
            resolveEnd = resolve;
        }),
        writeHead(status, headers) {
            this.calls.push(['writeHead', status, headers]);
            this.headersSent = true;
        },
        write(chunk) {
            this.calls.push(['write', chunk]);
        },
        end(body) {
            this.calls.push(['end', body]);
            resolveEnd();
        }
    };
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const deps = {
        calls,
        authenticateAndGetCredential: async () => ({
            credential: {id: 'cred-1', enterprise_id: 'ent-1', base_url: 'https://codebuddy.example.com'},
            tenantId: 42
        }),
        tenantManager: {
            getTenant: () => ({name: 'Tenant', username: 'alice'})
        },
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-4o',
            input: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        getCodebuddyBaseUrl: (baseUrl) => baseUrl,
        isPersonalHost: () => false,
        resolveConversationId: (...args) => {
            calls.push(['resolveConversationId', args]);
            return 'conv-responses';
        },
        responsesRequestToChat: (request) => ({
            model: request.model,
            messages: [{role: 'user', content: 'hello'}],
            stream: request.stream
        }),
        mapModelName: mapCodebuddyModelName,
        prepareCodebuddyOutboundChatRequest: (payload) => {
            calls.push(['prepare', payload]);
            return payload;
        },
        createChatCompletions: async (payload, context) => {
            calls.push(['createChatCompletions', payload, context]);
            return {body: 'upstream-body'};
        },
        createChatToResponsesStreamBridge: () => ({
            finished: false,
            feed(data) {
                calls.push(['bridgeFeed', data]);
                return [{event: 'response.output_text.delta', data: {type: 'response.output_text.delta', delta: 'hi'}}];
            },
            finish() {
                this.finished = true;
                calls.push(['bridgeFinish']);
                return [{event: 'response.completed', data: {type: 'response.completed'}}];
            }
        }),
        aggregateStreamResponse: async (body) => {
            calls.push(['aggregate', body]);
            return {
                id: 'chatcmpl_1',
                model: 'ep-hidden',
                content: 'hello back',
                reasoningContent: 'thinking',
                toolCalls: [],
                finishReason: 'stop',
                usage: {prompt_tokens: 5, completion_tokens: 7, credit: 1.25}
            };
        },
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        chatResponseToResponses: (response) => ({id: 'resp_1', source: response.id, usage: response.usage}),
        logger: {error: (...args) => calls.push(['logError', args]), warn: (...args) => calls.push(['logWarn', args])},
        ...overrides
    };
    return deps;
}

test('handleResponsesAPI returns OpenAI auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const deps = createBaseDeps({
        authenticateAndGetCredential: async () => ({
            error: {status: 401, message: 'Unauthorized'}
        }),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    });
    const handleResponsesAPI = createCodebuddyResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesAPI aggregates non-stream Chat responses into Responses output', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleResponsesAPI = createCodebuddyResponsesAPIHandler(deps);

    await handleResponsesAPI({
        headers: {
            'x-conversation-request-id': 'req-1',
            'x-conversation-message-id': 'msg-1',
            'x-request-id': 'trace-1'
        }
    }, res);

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[1].model, 'deepseek-v4-flash');
    assert.equal(createCall[2].conversationId, 'conv-responses');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 1.25, 'ep-hidden', 'gpt-4o']
    );
    assert.deepEqual(res.calls, [['json', 200, {
        id: 'resp_1',
        source: 'chatcmpl_1',
        usage: {prompt_tokens: 5, completion_tokens: 7, credit: 1.25}
    }]]);
});

test('handleResponsesAPI streams Chat chunks through the Responses bridge', async () => {
    const res = createResponse();
    const upstream = new PassThrough();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'claude-sonnet-4',
            input: [{role: 'user', content: 'hello'}],
            stream: true
        }),
        createChatCompletions: async (payload, context) => {
            deps.calls.push(['createChatCompletions', payload, context]);
            return {body: upstream};
        },
        extractCacheHitTokens: () => 3
    });
    const handleResponsesAPI = createCodebuddyResponsesAPIHandler(deps);

    await handleResponsesAPI({headers: {}}, res);
    upstream.write('data: {"model":"ep-hidden","choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"credit":0.5}}\n\n');
    upstream.end('data: [DONE]\n\n');
    await res.ended;

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(deps.calls.some((call) => call[0] === 'bridgeFeed'), true);
    assert.equal(res.calls.some((call) => call[0] === 'write' && call[1].includes('response.output_text.delta')), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 3, 4, 3, 0.5, 'ep-hidden', 'claude-sonnet-4']
    );
});
