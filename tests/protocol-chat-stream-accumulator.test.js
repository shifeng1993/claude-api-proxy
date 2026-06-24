import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatStreamAccumulator} from '../src/protocol-engine/core/stream/accumulators/chat.js';

test('createChatStreamAccumulator builds a final chat response from streamed deltas', () => {
    const accumulator = createChatStreamAccumulator({model: 'claude-test'});

    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {role: 'assistant'}, finish_reason: null}]
    });
    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {reasoning_content: 'thinking'}, finish_reason: null}]
    });
    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {content: 'hello'}, finish_reason: null}]
    });
    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'toolu_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: ''}
                }]
            },
            finish_reason: null
        }]
    });
    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: '{"path"'}
                }]
            },
            finish_reason: null
        }]
    });
    accumulator.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: ':"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7}
    });

    assert.deepEqual(accumulator.toChatResponse(), {
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: accumulator.created,
        model: 'claude-test',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: 'hello',
                reasoning_content: 'thinking',
                tool_calls: [{
                    id: 'toolu_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7}
    });
});
