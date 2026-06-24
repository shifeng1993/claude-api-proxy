import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanJsonSchema} from '../src/protocol-engine/core/index.js';

test('cleanJsonSchema removes only schema declaration recursively', () => {
    const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
            path: {
                $schema: 'nested',
                type: 'string',
                format: 'path',
                title: 'Path'
            }
        },
        additionalProperties: false
    };

    assert.deepEqual(cleanJsonSchema(schema), {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                format: 'path',
                title: 'Path'
            }
        },
        additionalProperties: false
    });
});
