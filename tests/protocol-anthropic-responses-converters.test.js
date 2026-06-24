import test from 'node:test';
import assert from 'node:assert/strict';
import {
    anthropicRequestToResponses,
    responsesResponseToAnthropic
} from '../src/protocol-engine/core/http-converters.js';

test('anthropicRequestToResponses maps messages, tools, and reasoning into Responses input', () => {
    const converted = anthropicRequestToResponses({
        model: 'claude-sonnet-4',
        system: [{type: 'text', text: 'Be concise.'}],
        max_tokens: 300,
        stream: true,
        temperature: 0.2,
        output_config: {effort: 'high'},
        tool_choice: {type: 'tool', name: 'read_file'},
        stop_sequences: ['END'],
        metadata: {session: 's1'},
        tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}}
        }],
        messages: [
            {
                role: 'user',
                content: [
                    {type: 'text', text: 'Inspect this'},
                    {type: 'image', source: {media_type: 'image/png', data: 'abc'}}
                ]
            },
            {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'Need file.'},
                    {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
                ]
            },
            {
                role: 'user',
                content: [
                    {type: 'tool_result', tool_use_id: 'toolu_1', content: 'README contents'}
                ]
            }
        ]
    });

    assert.equal(converted.model, 'claude-sonnet-4');
    assert.equal(converted.instructions, 'Be concise.');
    assert.equal(converted.max_output_tokens, 300);
    assert.deepEqual(converted.reasoning, {effort: 'high'});
    assert.deepEqual(converted.tool_choice, {type: 'function', name: 'read_file'});
    assert.deepEqual(converted.tools[0], {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: {type: 'object', properties: {path: {type: 'string'}}}
    });
    assert.deepEqual(converted.input, [
        {
            role: 'user',
            content: [
                {type: 'input_text', text: 'Inspect this'},
                {type: 'input_image', image_url: 'data:image/png;base64,abc'}
            ]
        },
        {
            role: 'assistant',
            content: [{type: 'output_text', text: 'Need file.'}]
        },
        {
            type: 'function_call',
            call_id: 'toolu_1',
            name: 'read_file',
            arguments: '{"path":"README.md"}'
        },
        {
            type: 'function_call_output',
            call_id: 'toolu_1',
            output: 'README contents'
        }
    ]);
    assert.deepEqual(converted.stop, ['END']);
    assert.deepEqual(converted.metadata, {session: 's1'});
});

test('responsesResponseToAnthropic maps text, reasoning, tool calls, stop reason, and cache usage', () => {
    const converted = responsesResponseToAnthropic({
        id: 'resp_123',
        model: 'gpt-test',
        status: 'completed',
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'I will read it.'}]
            },
            {
                type: 'reasoning',
                summary: [{type: 'summary_text', text: 'Need file.'}]
            },
            {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }
        ],
        usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: {cached_tokens: 3}
        }
    });

    assert.equal(converted.id, 'msg_123');
    assert.equal(converted.stop_reason, 'tool_use');
    assert.deepEqual(converted.content, [
        {type: 'text', text: 'I will read it.'},
        {type: 'thinking', thinking: 'Need file.'},
        {type: 'tool_use', id: 'call_1', name: 'read_file', input: {path: 'README.md'}}
    ]);
    assert.deepEqual(converted.usage, {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3
    });
});
