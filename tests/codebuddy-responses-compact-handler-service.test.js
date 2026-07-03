import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodebuddyResponsesCompactHandler} from '../src/services/codebuddy/protocols/responses/compact.js';
import {mapCodebuddyModelName} from '../src/services/codebuddy/model-mapping.js';

function createResponse() {
    return {calls: [], headersSent: false};
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
            input: [{role: 'user', content: 'compact me'}]
        }),
        resolveConversationId: (...args) => {
            calls.push(['resolveConversationId', args]);
            return 'conv-compact';
        },
        compactRequestToChat: (request) => ({
            model: request.model,
            messages: [{role: 'user', content: 'compact me'}]
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
        aggregateStreamResponse: async (body) => {
            calls.push(['aggregate', body]);
            return {
                id: 'chatcmpl_1',
                model: 'ep-hidden',
                content: 'compacted answer',
                finishReason: 'stop',
                usage: {prompt_tokens: 5, completion_tokens: 7, credit: 1.25}
            };
        },
        extractCacheHitTokens: () => 2,
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        chatResponseToCompact: (response) => ({compact: true, source: response.id, usage: response.usage}),
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
    return deps;
}

test('handleResponsesCompact returns OpenAI auth errors without reading the body', async () => {
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
    const handleResponsesCompact = createCodebuddyResponsesCompactHandler(deps);

    await handleResponsesCompact({headers: {}}, res);

    assert.equal(parsedBody, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleResponsesCompact aggregates Chat responses into compact responses', async () => {
    const res = createResponse();
    const deps = createBaseDeps();
    const handleResponsesCompact = createCodebuddyResponsesCompactHandler(deps);

    await handleResponsesCompact({headers: {}}, res);

    const createCall = deps.calls.find((call) => call[0] === 'createChatCompletions');
    assert.equal(createCall[1].model, 'deepseek-v4-flash');
    assert.equal(createCall[2].conversationId, 'conv-compact');
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordUsage')?.[1],
        [42, 5, 7, 2, 1.25, 'ep-hidden', 'gpt-4o']
    );
    assert.deepEqual(res.calls, [['json', 200, {
        compact: true,
        source: 'chatcmpl_1',
        usage: {prompt_tokens: 5, completion_tokens: 7, credit: 1.25}
    }]]);
});
