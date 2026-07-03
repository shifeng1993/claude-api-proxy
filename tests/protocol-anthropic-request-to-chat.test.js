import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicRequestToChat} from '../src/protocol-engine/core/http-converters.js';

test('anthropicRequestToChat preserves reasoning and orders tool results by assistant tool calls', () => {
    const converted = anthropicRequestToChat({
        model: 'claude-sonnet-4',
        system: [{type: 'text', text: 'Be precise.'}],
        max_tokens: 200,
        stream: false,
        output_config: {effort: 'medium'},
        tool_choice: {type: 'tool', name: 'read_file'},
        tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: {path: {type: 'string'}}
            }
        }],
        messages: [
            {role: 'user', content: [{type: 'text', text: 'Read two files'}]},
            {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'Need both files.'},
                    {type: 'tool_use', id: 'call_b', name: 'read_file', input: {path: 'b.txt'}},
                    {type: 'tool_use', id: 'call_a', name: 'read_file', input: {path: 'a.txt'}}
                ]
            },
            {
                role: 'user',
                content: [
                    {type: 'tool_result', tool_use_id: 'call_a', content: 'A'},
                    {type: 'tool_result', tool_use_id: 'call_b', content: 'B'},
                    {type: 'text', text: 'Continue'}
                ]
            }
        ]
    }, {cleanToolSchema: true});

    assert.equal(converted.model, 'claude-sonnet-4');
    assert.equal(converted.reasoning_effort, 'medium');
    assert.deepEqual(converted.tool_choice, {type: 'function', function: {name: 'read_file'}});
    assert.deepEqual(converted.tools[0].function.parameters, {
        type: 'object',
        properties: {path: {type: 'string'}}
    });

    assert.deepEqual(converted.messages.map((message) => message.role), [
        'system',
        'user',
        'assistant',
        'tool',
        'tool',
        'user'
    ]);
    assert.equal(converted.messages[2].content, '');
    assert.equal(converted.messages[2].reasoning_content, 'Need both files.');
    assert.deepEqual(converted.messages[2].tool_calls.map((toolCall) => toolCall.id), ['call_b', 'call_a']);
    assert.deepEqual(converted.messages.slice(3, 5).map((message) => [message.tool_call_id, message.content]), [
        ['call_b', 'B'],
        ['call_a', 'A']
    ]);
    assert.equal(converted.messages[5].content, 'Continue');
});

test('anthropicRequestToChat supports system ordering and tool argument serialization options', () => {
    const converted = anthropicRequestToChat({
        model: 'claude-haiku-4',
        system: [
            {type: 'text', text: 'dynamic instructions'},
            {type: 'text', text: 'static instructions', cache_control: {type: 'ephemeral'}}
        ],
        messages: [{
            role: 'assistant',
            content: [
                {type: 'tool_use', id: 'call_1', name: 'noop'}
            ]
        }]
    }, {
        prioritizeCacheControlSystemBlocks: true,
        toolArgumentsSerializer: (input) => JSON.stringify(input),
        disableReasoningForModel: (model) => model.includes('haiku')
    });

    assert.equal(converted.reasoning_effort, '');
    assert.equal(converted.messages[0].content, 'static instructions\n\ndynamic instructions');
    assert.equal(converted.messages[1].tool_calls[0].function.arguments, undefined);
});

test('anthropicRequestToChat ignores null system and content blocks', () => {
    const converted = anthropicRequestToChat({
        model: 'claude-haiku-4',
        system: [null, {type: 'text', text: 'System text'}],
        messages: [{
            role: 'user',
            content: [null, {type: 'text', text: 'Hello'}]
        }]
    }, {
        prioritizeCacheControlSystemBlocks: true
    });

    assert.deepEqual(converted.messages, [
        {role: 'system', content: 'System text'},
        {role: 'user', content: 'Hello'}
    ]);
});
