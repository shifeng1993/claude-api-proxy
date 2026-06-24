import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotAnthropicMessagesHandler} from '../src/services/copilot/anthropic-messages-handler.js';

function createResponse() {
    return {
        calls: [],
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        writeHead(status, headers) {
            this.headersSent = true;
            this.calls.push(['writeHead', status, headers]);
        },
        write(chunk) {
            this.calls.push(['write', chunk]);
        },
        end(body) {
            this.writableEnded = true;
            this.calls.push(['end', body]);
        },
        on(event, handler) {
            this.calls.push(['on', event, handler]);
        }
    };
}

async function* events(items) {
    for (const item of items) {
        yield item;
    }
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    const store = {
        incrementApiCallCount: () => calls.push(['incrementApiCallCount']),
        incrementTokenUsage: (...args) => calls.push(['incrementTokenUsage', args]),
        recordDailyUsage: (...args) => calls.push(['recordDailyUsage', args])
    };
    return {
        calls,
        getCopilotNetworkOptions: () => ({proxyUrl: 'http://proxy.test', rejectUnauthorized: false}),
        ensureCopilotAuth: async () => ({copilotToken: 'token-1'}),
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            messages: [{role: 'user', content: 'hello'}],
            stream: false
        }),
        sanitizeAnthropicPayload: (payload) => payload,
        extractConversationKey: (...args) => {
            calls.push(['extractConversationKey', args]);
            return 'conv-1';
        },
        anthropicToResponses: (payload) => {
            calls.push(['anthropicToResponses', payload]);
            return {model: payload.model, input: payload.messages};
        },
        ensureResponsesWebSocketSupported: (model) => calls.push(['ensureResponsesWebSocketSupported', model]),
        createResponsesWS: async (...args) => {
            calls.push(['createResponsesWS', args]);
            return {
                conn: {id: 'conn-1'},
                eventStream: events([
                    {
                        type: 'response.completed',
                        data: {response: {id: 'resp-1', usage: {input_tokens: 5, output_tokens: 7}}}
                    }
                ])
            };
        },
        copilotState: {
            vsCodeVersion: '1.109.2',
            accountType: 'individual'
        },
        createResponsesToAnthropicStreamBridge: () => ({
            finished: false,
            feed: (type) => type === 'response.completed'
                ? [{type: 'content_block_delta', delta: {text: 'hi'}}]
                : [],
            finish: () => [{type: 'message_stop'}]
        }),
        convertResponsesUsageToChat: () => ({prompt_tokens: 5, completion_tokens: 7}),
        extractCacheHitTokens: () => 2,
        releaseWSConnection: (conn) => calls.push(['releaseWSConnection', conn]),
        discardWSConnection: (conn) => calls.push(['discardWSConnection', conn]),
        responsesResponseToChat: () => ({
            choices: [{message: {content: 'hi'}}],
            usage: {prompt_tokens: 5, completion_tokens: 7}
        }),
        openAIToAnthropic: () => ({content: [{type: 'text', text: 'hi'}]}),
        copilotStore: store,
        estimateMessageTokens: () => 11,
        anthropicToOpenAI: (payload) => ({model: payload.model, messages: payload.messages, stream: payload.stream}),
        createChatCompletions: async (...args) => {
            calls.push(['createChatCompletions', args]);
            return {status: 200, body: null};
        },
        readBody: async () => JSON.stringify({
            choices: [{message: {content: 'fallback'}}],
            usage: {prompt_tokens: 3, completion_tokens: 4}
        }),
        createChatToAnthropicStreamBridge: () => ({
            finished: true,
            feed: () => [],
            finish: () => []
        }),
        logger: {
            info: (...args) => calls.push(['logInfo', args]),
            warn: (...args) => calls.push(['logWarn', args]),
            error: (...args) => calls.push(['logError', args])
        },
        ...overrides
    };
}

test('handleAnthropicMessages returns auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const handler = createCopilotAnthropicMessagesHandler(createBaseDeps({
        ensureCopilotAuth: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    }));

    await handler({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['anthropic-error', 401, 'Unauthorized']]);
});

test('handleAnthropicMessages returns non-stream Responses WS completions as Anthropic', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handler = createCopilotAnthropicMessagesHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(deps.calls.some((call) => call[0] === 'releaseWSConnection'), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'incrementTokenUsage')?.[1],
        [5, 7, 2]
    );
    assert.deepEqual(res.calls[0], ['json', 200, {content: [{type: 'text', text: 'hi'}]}]);
});

test('handleAnthropicMessages streams Responses WS events as Anthropic SSE', async () => {
    const res = createResponse();
    const deps = createBaseDeps({
        parseBody: async () => JSON.stringify({
            model: 'gpt-5.1',
            messages: [{role: 'user', content: 'hello'}],
            stream: true
        })
    });
    const handler = createCopilotAnthropicMessagesHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(res.calls[0][0], 'writeHead');
    assert.equal(res.calls.some((call) => call[0] === 'write' && call[1].includes('content_block_delta')), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordDailyUsage')?.[1],
        [5, 7, 2, undefined]
    );
});
