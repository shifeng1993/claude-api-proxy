import test from 'node:test';
import assert from 'node:assert/strict';
import {
    anthropicRequestToResponses,
    responsesResponseToAnthropic
} from '../src/protocol-engine/core/http-converters.js';
import {sanitizeResponsesInput} from '../src/protocol-engine/core/responses.js';

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
            ],
            x_relay_anthropic_content: [
                {type: 'text', text: 'Inspect this'},
                {type: 'image', source: {media_type: 'image/png', data: 'abc'}}
            ]
        },
        {
            type: 'reasoning',
            summary: [{type: 'summary_text', text: 'Need file.'}],
            x_relay_anthropic_thinking: [
                {type: 'thinking', thinking: 'Need file.'}
            ]
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

test('anthropicRequestToResponses preserves signed thinking for relay Responses bridge', () => {
    const converted = anthropicRequestToResponses({
        model: 'claude-sonnet-4',
        thinking: {type: 'enabled', budget_tokens: 10000},
        messages: [
            {
                role: 'user',
                content: [{type: 'text', text: 'Read README'}]
            },
            {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'Need file.', signature: 'sig_1'},
                    {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
                ]
            },
            {
                role: 'user',
                content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: 'README text'}]
            }
        ]
    });

    assert.deepEqual(converted.input, [
        {role: 'user', content: [{type: 'input_text', text: 'Read README'}]},
        {
            type: 'reasoning',
            summary: [{type: 'summary_text', text: 'Need file.'}],
            x_relay_anthropic_thinking: [
                {type: 'thinking', thinking: 'Need file.', signature: 'sig_1'}
            ]
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
            output: 'README text'
        }
    ]);
    assert.deepEqual(converted.x_relay_anthropic_thinking_config, {
        type: 'enabled',
        budget_tokens: 10000
    });
});

test('anthropicRequestToResponses preserves Anthropic-only request fields for relay fallback', () => {
    const converted = anthropicRequestToResponses({
        model: 'claude-sonnet-4',
        system: [
            {type: 'text', text: 'static instructions', cache_control: {type: 'ephemeral'}},
            {type: 'text', text: 'dynamic instructions'}
        ],
        top_k: 20,
        stop_sequences: ['END'],
        metadata: {user_id: 'user-1'},
        tool_choice: {type: 'auto', disable_parallel_tool_use: true},
        tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}},
            cache_control: {type: 'ephemeral'}
        }],
        messages: [
            {
                role: 'user',
                content: [
                    {type: 'text', text: 'Read this', cache_control: {type: 'ephemeral'}},
                    {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'pdf-data'}}
                ]
            },
            {
                role: 'assistant',
                content: [
                    {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
                ]
            },
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    is_error: true,
                    content: [{type: 'text', text: 'not found', cache_control: {type: 'ephemeral'}}],
                    cache_control: {type: 'ephemeral'}
                }]
            }
        ]
    });

    assert.deepEqual(converted.x_relay_anthropic_request, {
        system: [
            {type: 'text', text: 'static instructions', cache_control: {type: 'ephemeral'}},
            {type: 'text', text: 'dynamic instructions'}
        ],
        top_k: 20,
        stop_sequences: ['END'],
        metadata: {user_id: 'user-1'},
        tools: [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}},
            cache_control: {type: 'ephemeral'}
        }],
        tool_choice: {type: 'auto', disable_parallel_tool_use: true}
    });
    assert.deepEqual(converted.input[0].x_relay_anthropic_content, [
        {type: 'text', text: 'Read this', cache_control: {type: 'ephemeral'}},
        {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'pdf-data'}}
    ]);
    const toolResultItem = converted.input.find((item) => item.type === 'function_call_output');
    assert.deepEqual(toolResultItem.x_relay_anthropic_tool_result, {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [{type: 'text', text: 'not found', cache_control: {type: 'ephemeral'}}],
        cache_control: {type: 'ephemeral'}
    });
});

test('sanitizeResponsesInput preserves relay Anthropic private fields for relay WebSocket transport', () => {
    const input = sanitizeResponsesInput([
        {
            role: 'user',
            content: [{type: 'input_text', text: 'Read this'}],
            x_relay_anthropic_content: [
                {type: 'text', text: 'Read this', cache_control: {type: 'ephemeral'}}
            ]
        },
        {
            type: 'function_call_output',
            call_id: 'toolu_1',
            output: 'failed',
            x_relay_anthropic_tool_result: {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                is_error: true,
                content: [{type: 'text', text: 'failed'}]
            }
        }
    ]);

    assert.deepEqual(input[0].x_relay_anthropic_content, [
        {type: 'text', text: 'Read this', cache_control: {type: 'ephemeral'}}
    ]);
    assert.deepEqual(input[1].x_relay_anthropic_tool_result, {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
        content: [{type: 'text', text: 'failed'}]
    });
});

test('responsesResponseToAnthropic renders unsigned reasoning summaries as Anthropic thinking', () => {
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
    assert.deepEqual(converted.content.map((block) => block.type), ['text', 'thinking', 'tool_use']);
    const thinking = converted.content.find((block) => block.type === 'thinking');
    assert.equal(thinking.thinking, 'Need file.');
    assert.ok(thinking.signature);
    assert.deepEqual(converted.content.find((block) => block.type === 'tool_use'), {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: {path: 'README.md'}
    });
    assert.deepEqual(converted.usage, {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3
    });
});
