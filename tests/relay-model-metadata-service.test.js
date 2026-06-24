import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getAnthropicRequestHeaders,
    mapAnthropicModelsToOpenAI,
    mapOpenAIModelsToAnthropic
} from '../src/services/relay/model-metadata.js';

test('mapAnthropicModelsToOpenAI renders Anthropic model metadata as OpenAI list items', () => {
    const result = mapAnthropicModelsToOpenAI({
        data: [{
            id: 'claude-sonnet-4',
            created_at: '2026-06-24T00:00:00.000Z',
            display_name: 'Claude Sonnet 4'
        }, {
            id: 'claude-haiku',
            type: 'model'
        }]
    });

    assert.deepEqual(result, {
        object: 'list',
        data: [{
            id: 'claude-sonnet-4',
            object: 'model',
            created: 1782259200,
            owned_by: 'Claude Sonnet 4'
        }, {
            id: 'claude-haiku',
            object: 'model',
            created: 0,
            owned_by: 'model'
        }]
    });
});

test('mapAnthropicModelsToOpenAI tolerates missing data arrays', () => {
    assert.deepEqual(mapAnthropicModelsToOpenAI(null), {
        object: 'list',
        data: []
    });
});

test('mapOpenAIModelsToAnthropic renders OpenAI model metadata as Anthropic list items', () => {
    const result = mapOpenAIModelsToAnthropic({
        data: [{
            id: 'gpt-5',
            created: 1782259200,
            owned_by: 'openai'
        }, {
            id: 'relay-model',
            owner: 'relay-owner'
        }]
    });

    assert.deepEqual(result, {
        data: [{
            id: 'gpt-5',
            object: 'model',
            created: 1782259200,
            owned_by: 'openai',
            name: 'gpt-5',
            capabilities: {}
        }, {
            id: 'relay-model',
            object: 'model',
            created: 0,
            owned_by: 'relay-owner',
            name: 'relay-model',
            capabilities: {}
        }],
        object: 'list'
    });
});

test('getAnthropicRequestHeaders defaults version and forwards beta header', () => {
    assert.deepEqual(
        getAnthropicRequestHeaders({headers: {}}),
        {'anthropic-version': '2023-06-01'}
    );
    assert.deepEqual(
        getAnthropicRequestHeaders({
            headers: {
                'anthropic-version': '2026-01-01',
                'anthropic-beta': 'tools-2026-01-01'
            }
        }),
        {
            'anthropic-version': '2026-01-01',
            'anthropic-beta': 'tools-2026-01-01'
        }
    );
});
