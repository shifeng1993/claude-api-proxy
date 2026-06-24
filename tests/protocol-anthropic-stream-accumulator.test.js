import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnthropicStreamAccumulator} from '../src/protocol-engine/core/stream/accumulators/anthropic.js';

test('createAnthropicStreamAccumulator builds a final Anthropic response from streamed events', () => {
    const accumulator = createAnthropicStreamAccumulator({model: 'claude-test'});

    accumulator.feed('message_start', {
        message: {
            id: 'msg_1',
            model: 'claude-test',
            usage: {input_tokens: 10, cache_read_input_tokens: 3}
        }
    });
    accumulator.feed('content_block_start', {
        index: 0,
        content_block: {type: 'thinking', thinking: ''}
    });
    accumulator.feed('content_block_delta', {
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'Need the file.'}
    });
    accumulator.feed('content_block_delta', {
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig_1'}
    });
    accumulator.feed('content_block_start', {
        index: 1,
        content_block: {type: 'text', text: ''}
    });
    accumulator.feed('content_block_delta', {
        index: 1,
        delta: {type: 'text_delta', text: 'I will read it.'}
    });
    accumulator.feed('content_block_start', {
        index: 2,
        content_block: {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {}}
    });
    accumulator.feed('content_block_delta', {
        index: 2,
        delta: {type: 'input_json_delta', partial_json: '{"path"' }
    });
    accumulator.feed('content_block_delta', {
        index: 2,
        delta: {type: 'input_json_delta', partial_json: ':"README.md"}'}
    });
    accumulator.feed('message_delta', {
        delta: {stop_reason: 'tool_use'},
        usage: {output_tokens: 7}
    });

    assert.deepEqual(accumulator.toAnthropicResponse(), {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [
            {type: 'thinking', thinking: 'Need the file.', signature: 'sig_1'},
            {type: 'text', text: 'I will read it.'},
            {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
        ],
        stop_reason: 'tool_use',
        usage: {
            input_tokens: 10,
            output_tokens: 7,
            cache_read_input_tokens: 3
        }
    });
});

test('createAnthropicStreamAccumulator returns null when no message was seen', () => {
    const accumulator = createAnthropicStreamAccumulator();

    assert.equal(accumulator.toAnthropicResponse(), null);
});
