import test from 'node:test';
import assert from 'node:assert/strict';
import {createCopilotMetadataHandlers} from '../src/services/copilot/metadata-handler.js';

function createResponse() {
    return {calls: []};
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    return {
        calls,
        getCopilotNetworkOptions: () => ({proxyUrl: 'http://proxy.test', rejectUnauthorized: false}),
        ensureCopilotAuth: async () => ({copilotToken: 'token-1'}),
        getModels: async () => ({
            data: [{id: 'gpt-5.1', name: 'GPT 5.1', vendor: 'github', capabilities: {streaming: true}}]
        }),
        copilotState: {
            vsCodeVersion: '1.109.2',
            accountType: 'individual'
        },
        sendOpenAIError: (res, status, message, type) => res.calls.push(['openai-error', status, message, type]),
        sendAnthropicError: (res, status, message) => res.calls.push(['anthropic-error', status, message]),
        sendJson: (res, status, data) => res.calls.push(['json', status, data]),
        upstreamErrorStatus: (error) => error.status || 500,
        parseBody: async () => JSON.stringify({messages: [{role: 'user', content: 'hi'}]}),
        sanitizeAnthropicPayload: (payload) => payload,
        estimateMessageTokens: () => 7,
        estimateContentBlockTokens: () => 3,
        logger: {error: (...args) => calls.push(['logError', args])},
        ...overrides
    };
}

test('handleOpenAIModels returns auth errors without fetching models', async () => {
    const res = createResponse();
    let fetched = false;
    const deps = createBaseDeps({
        ensureCopilotAuth: async () => ({error: {status: 401, message: 'Unauthorized'}}),
        getModels: async () => {
            fetched = true;
        }
    });
    const {handleOpenAIModels} = createCopilotMetadataHandlers(deps);

    await handleOpenAIModels({headers: {}}, res);

    assert.equal(fetched, false);
    assert.deepEqual(res.calls, [['openai-error', 401, 'Unauthorized', undefined]]);
});

test('handleOpenAIModels renders OpenAI model list shape', async () => {
    const res = createResponse();
    const {handleOpenAIModels} = createCopilotMetadataHandlers(createBaseDeps());

    await handleOpenAIModels({headers: {}}, res);

    assert.deepEqual(res.calls[0], ['json', 200, {
        object: 'list',
        data: [{
            id: 'gpt-5.1',
            object: 'model',
            created: 0,
            owned_by: 'github'
        }]
    }]);
});

test('handleAnthropicCountTokens estimates sanitized messages system and tools', async () => {
    const res = createResponse();
    const {handleAnthropicCountTokens} = createCopilotMetadataHandlers(createBaseDeps({
        sanitizeAnthropicPayload: (payload) => ({
            ...payload,
            system: [{type: 'text', text: 'system'}],
            tools: [{
                name: 'tool',
                description: 'describe',
                input_schema: {type: 'object'}
            }]
        })
    }));

    await handleAnthropicCountTokens({headers: {}}, res);

    assert.deepEqual(res.calls[0], ['json', 200, {input_tokens: 22}]);
});

test('handleAnthropicModels renders Anthropic model list shape', async () => {
    const res = createResponse();
    const {handleAnthropicModels} = createCopilotMetadataHandlers(createBaseDeps());

    await handleAnthropicModels({headers: {}}, res);

    assert.deepEqual(res.calls[0], ['json', 200, {
        object: 'list',
        data: [{
            id: 'gpt-5.1',
            object: 'model',
            created: 0,
            owned_by: 'github',
            name: 'GPT 5.1',
            capabilities: {streaming: true}
        }]
    }]);
});
