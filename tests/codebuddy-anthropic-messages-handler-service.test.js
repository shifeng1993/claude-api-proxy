import {PassThrough} from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyAnthropicMessagesHandler} from '../src/services/codebuddy/protocols/anthropic/messages.js';
import {mapCodebuddyModelName} from '../src/services/codebuddy/model-mapping.js';

function createResponse() {
    let resolveEnd;
    return {
        calls: [],
        headersSent: false,
        destroyed: false,
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
            credential: {id: 'cred-1'},
            tenantId: 42
        }),
        tenantManager: {
            getTenant: () => ({name: 'Tenant', username: 'alice'})
        },
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-4o',
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        sanitizeAnthropicPayload: (payload) => ({...payload, sanitized: true}),
        anthropicToOpenAI: (payload) => ({
            model: payload.model,
            messages: payload.messages.map((message) => ({role: message.role, content: message.content})),
            stream: payload.stream
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
        createChatToAnthropicStreamBridge: () => ({
            finished: false,
            feed(data) {
                calls.push(['bridgeFeed', data]);
                return [{type: 'content_block_delta', delta: {text: data.choices?.[0]?.delta?.content || ''}}];
            },
            finish() {
                this.finished = true;
                calls.push(['bridgeFinish']);
                return [{type: 'message_stop'}];
            }
        }),
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
        openAIToAnthropic: (response) => ({
            type: 'message',
            id: response.id,
            model: response.model,
            text: response.choices[0].message.content
        }),
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
    return deps;
}

test('handleAnthropicMessages returns auth errors without reading the body', async () => {
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
    const handleAnthropicMessages = createCodebuddyAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['anthropic-error', 401, 'Unauthorized']]);
});

test('handleAnthropicMessages aggregates non-stream responses and records usage', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleAnthropicMessages = createCodebuddyAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({
        headers: {
            'x-conversation-request-id': 'req-1',
            'x-conversation-message-id': 'msg-1',
            'x-request-id': 'trace-1'
        }
    }, res);

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[1].model, 'deepseek-v4-flash');
    assert.equal(createCall[2].conversationId, 'conv-1');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 1.25, 'ep-hidden', 'gpt-4o']
    );
    assert.deepEqual(res.calls, [['json', 200, {
        type: 'message',
        id: 'chatcmpl_1',
        model: 'ep-hidden',
        text: 'hi'
    }]]);
});

test('handleAnthropicMessages streams Chat chunks through the Anthropic bridge', async () => {
    const res = createResponse();
    const upstream = new PassThrough();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'claude-sonnet-4',
            messages: [{role: 'user', content: 'hello'}],
            stream: true
        }),
        createChatCompletions: async (payload, context) => {
            deps.calls.push(['createChatCompletions', payload, context]);
            return {body: upstream};
        },
        extractCacheHitTokens: () => 3
    });
    const handleAnthropicMessages = createCodebuddyAnthropicMessagesHandler(deps);

    await handleAnthropicMessages({headers: {}}, res);
    upstream.write('data: {"model":"ep-hidden","choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"credit":0.5}}\n\n');
    upstream.end('data: [DONE]\n\n');
    await res.ended;

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(deps.calls.some((call) => call[0] === 'bridgeFeed'), true);
    assert.equal(res.calls.some((call) => call[0] === 'write' && call[1].includes('content_block_delta')), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 3, 4, 3, 0.5, 'ep-hidden', 'claude-sonnet-4']
    );
});
