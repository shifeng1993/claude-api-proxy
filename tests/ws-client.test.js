import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWebSocketPayload} from '../src/services/copilot/copilot-ws-client.js';

test('prepareWebSocketPayload removes HTTP transport fields', () => {
    const payload = prepareWebSocketPayload({
        model: 'gpt-4.1',
        stream: true,
        background: false,
        input: [{role: 'user', content: [{type: 'input_text', text: 'hi'}]}]
    });

    assert.deepEqual(payload, {
        model: 'gpt-4.1',
        input: [{role: 'user', content: [{type: 'input_text', text: 'hi'}]}]
    });
});
