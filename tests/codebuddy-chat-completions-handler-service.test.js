import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyChatCompletionsHandler} from '../src/services/codebuddy/protocols/chat/completions.js';
import {mapCodebuddyModelName} from '../src/services/codebuddy/model-mapping.js';

function createResponse() {
    return {
        calls: [],
        headersSent: false,
        writeHead(status, headers) {
            this.calls.push(['writeHead', status, headers]);
            this.headersSent = true;
        },
        end(body) {
            this.calls.push(['end', body]);
        }
    };
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const deps = {
        calls,
        authenticateAndGetCredential: async () => ({
            credential: {id: 'cred-1'},
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
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        mapModelName: mapCodebuddyModelName,
        resolveConversationId: (...args) => {
            calls.push(['resolveConversationId', args]);
            return 'conv-1';
        },
        prepareCodebuddyOutboundChatRequest: (payload) => {
            calls.push(['prepare', payload]);
            return payload;
        },
        createChatCompletions: async (payload, context) => {
            calls.push(['createChatCompletions', payload, context]);
            return {body: 'upstream-body'};
        },
        rewriteOpenAIStream: (res, body, onUsage, _onChunk, options) => {
            calls.push(['rewriteOpenAIStream', body, options]);
            onUsage(3, 4, 1, 0.5, 'ep-hidden');
        },
        aggregateStreamResponse: async (body) => {
            calls.push(['aggregate', body]);
            return {
                id: 'chatcmpl_1',
                model: 'ep-hidden',
                content: 'hi',
                reasoningContent: 'thought',
                toolCalls: [],
                finishReason: 'stop',
                usage: {prompt_tokens: 5, completion_tokens: 7, credit: 1.25}
            };
        },
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
    return deps;
}

test('handleOpenAIChatCompletions returns auth errors without reading the body', async () => {
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
    const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', 'authentication_error']]);
});

test('handleOpenAIChatCompletions aggregates non-stream responses and records usage', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({
        headers: {
            'x-conversation-request-id': 'req-1',
            'x-conversation-message-id': 'msg-1',
            'x-request-id': 'trace-1'
        }
    }, res);

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[1].model, 'deepseek-v4-flash');
    assert.equal(createCall[2].conversationId, 'conv-1');
    assert.equal(createCall[2].conversationRequestId, 'req-1');
    assert.equal(createCall[2].tenantName, 'Tenant');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 1.25, 'ep-hidden', 'deepseek-v4-flash']
    );
    assert.equal(res.calls[0][0], 'json');
    assert.equal(res.calls[0][1], 200);
    assert.equal(res.calls[0][2].choices[0].message.content, 'hi');
});

test('handleOpenAIChatCompletions streams through rewriteOpenAIStream and records callback usage', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'claude-sonnet-4',
            messages: [{role: 'user', content: 'hello'}],
            stream: true
        })
    });
    const handleOpenAIChatCompletions = createCodebuddyChatCompletionsHandler(deps);

    await handleOpenAIChatCompletions({headers: {}}, res);

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(deps.calls.some((call) => call[0] === 'rewriteOpenAIStream'), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 3, 4, 1, 0.5, 'ep-hidden', 'claude-sonnet-4']
    );
});
