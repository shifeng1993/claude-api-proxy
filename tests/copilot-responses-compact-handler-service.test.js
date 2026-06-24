import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotResponsesCompactHandler} from '../src/services/copilot/responses-compact-handler.js';

function createResponse() {
    return {calls: []};
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
        getCopilotNetworkOptions: () => ({proxyUrl: 'http://proxy.test', rejectUnauthorized: true}),
        ensureCopilotAuth: async () => ({copilotToken: 'token-1'}),
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({model: 'gpt-5.1', input: 'hello'}),
        compactRequestToChat: (payload) => {
            calls.push(['compactRequestToChat', payload]);
            return {model: payload.model, messages: [{role: 'user', content: payload.input}]};
        },
        createChatCompletions: async (...args) => {
            calls.push(['createChatCompletions', args]);
            return {status: 200, body: 'chat-body'};
        },
        copilotState: {
            vsCodeVersion: '1.109.2',
            accountType: 'individual'
        },
        readBody: async () => JSON.stringify({
            choices: [{message: {content: 'hi'}}],
            usage: {prompt_tokens: 5, completion_tokens: 7}
        }),
        extractCacheHitTokens: () => 2,
        copilotStore: store,
        chatResponseToCompact: (chatResponse) => ({output_text: chatResponse.choices[0].message.content}),
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
}

test('handleResponsesCompact returns auth errors without reading the body', async () => {
    const res = createResponse();
    let parsedBody = false;
    const handler = createCopilotResponsesCompactHandler(createBaseDeps({
        ensureCopilotAuth: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        parseBody: async () => {
            parsedBody = true;
            return '{}';
        }
    }));

    await handler({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesCompact converts through Chat and records usage', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handler = createCopilotResponsesCompactHandler(deps);

    await handler({headers: {}}, res);

    assert.equal(deps.calls.some((call) => call[0] === 'createChatCompletions'), true);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'incrementTokenUsage')?.[1],
        [5, 7, 2]
    );
    assert.deepEqual(res.calls[0], ['json', 200, {output_text: 'hi'}]);
});
