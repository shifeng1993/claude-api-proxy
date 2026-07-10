import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canonicalFromAnthropicStreamChatResponse,
    canonicalFromAnthropicRequest,
    canonicalFromChatRequest,
    canonicalFromResponsesRequest,
    renderCanonicalToAnthropic,
    renderCanonicalToChat,
    renderCanonicalToResponses
} from '../src/protocol-engine/core/canonical/session.js';

test('canonical session preserves OpenAI Chat tool call and result ids', () => {
    const session = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [
            {role: 'system', content: 'Be concise.'},
            {role: 'user', content: 'Read README'},
            {
                role: 'assistant',
                reasoning_content: 'Need file contents.',
                content: '',
                tool_calls: [{
                    id: 'call_chat_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            {role: 'tool', tool_call_id: 'call_chat_1', content: 'README text'}
        ],
        tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
        tool_choice: 'auto'
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    assert.equal(session.turns.length, 4);
    assert.equal(session.toolMappings[0].openAIChatToolCallId, 'call_chat_1');
    assert.equal(session.turns[2].blocks[0].type, 'reasoning');
    assert.equal(session.turns[2].blocks[1].type, 'tool_call');

    const chat = renderCanonicalToChat(session);
    assert.equal(chat.messages[2].tool_calls[0].id, 'call_chat_1');
    assert.equal(chat.messages[3].tool_call_id, 'call_chat_1');
});

test('canonical session maps Responses call_id and item_id separately', () => {
    const session = canonicalFromResponsesRequest({
        model: 'gpt-test',
        instructions: 'Be concise.',
        input: [
            {role: 'user', content: [{type: 'input_text', text: 'Read README'}]},
            {type: 'reasoning', id: 'rs_1', summary: [{type: 'summary_text', text: 'Need file contents.'}]},
            {type: 'function_call', id: 'fc_1', call_id: 'call_resp_1', name: 'read_file', arguments: '{"path":"README.md"}'},
            {type: 'function_call_output', call_id: 'call_resp_1', output: 'README text'}
        ],
        previous_response_id: 'resp_prev'
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    const mapping = session.toolMappings[0];
    assert.equal(mapping.responsesCallId, 'call_resp_1');
    assert.equal(mapping.responsesItemId, 'fc_1');
    assert.equal(session.previousResponseId, 'resp_prev');

    const responses = renderCanonicalToResponses(session);
    const toolCall = responses.input.find((item) => item.type === 'function_call');
    const toolResult = responses.input.find((item) => item.type === 'function_call_output');
    assert.equal(toolCall.call_id, 'call_resp_1');
    assert.equal(toolCall.id, 'fc_1');
    assert.equal(toolResult.call_id, 'call_resp_1');
});

test('canonical session restores relay Anthropic thinking signatures from Responses input', () => {
    const session = canonicalFromResponsesRequest({
        model: 'gpt-test',
        input: [
            {role: 'user', content: [{type: 'input_text', text: 'Read README'}]},
            {
                type: 'reasoning',
                summary: [{type: 'summary_text', text: 'Need file contents.'}],
                x_relay_anthropic_thinking: [
                    {type: 'thinking', thinking: 'Need file contents.', signature: 'sig_1'}
                ]
            },
            {type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"README.md"}'},
            {type: 'function_call_output', call_id: 'toolu_1', output: 'README text'}
        ]
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    const anthropic = renderCanonicalToAnthropic(session);

    assert.deepEqual(anthropic.messages[1].content[0], {
        type: 'thinking',
        thinking: 'Need file contents.',
        signature: 'sig_1'
    });
    assert.equal(anthropic.messages[1].content[1].type, 'tool_use');
    assert.equal(anthropic.messages[2].content[0].tool_use_id, 'toolu_1');
});

test('canonical session groups parallel Responses tool outputs into one Anthropic user message', () => {
    const session = canonicalFromResponsesRequest({
        model: 'gpt-test',
        input: [
            {role: 'user', content: [{type: 'input_text', text: 'Run checks'}]},
            {type: 'function_call', call_id: 'toolu_a', name: 'Bash', arguments: '{"command":"git status"}'},
            {type: 'function_call', call_id: 'toolu_b', name: 'Bash', arguments: '{"command":"npm test"}'},
            {type: 'function_call', call_id: 'toolu_c', name: 'Bash', arguments: '{"command":"node -v"}'},
            {type: 'function_call_output', call_id: 'toolu_c', output: 'v22.0.0'},
            {type: 'function_call_output', call_id: 'toolu_b', output: 'pass'},
            {type: 'function_call_output', call_id: 'toolu_a', output: 'clean'}
        ]
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    const anthropic = renderCanonicalToAnthropic(session);

    assert.deepEqual(
        anthropic.messages.map((message) => message.role),
        ['user', 'assistant', 'user']
    );
    assert.deepEqual(
        anthropic.messages[2].content.map((block) => block.tool_use_id),
        ['toolu_a', 'toolu_b', 'toolu_c']
    );
});

test('canonical session omits unsigned Responses reasoning when rendering Anthropic messages', () => {
    const session = canonicalFromResponsesRequest({
        model: 'gpt-test',
        input: [
            {role: 'user', content: [{type: 'input_text', text: 'Read README'}]},
            {
                type: 'reasoning',
                summary: [{type: 'summary_text', text: 'Need file contents.'}]
            },
            {
                role: 'assistant',
                content: [{type: 'output_text', text: 'I will read it.'}]
            },
            {type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"README.md"}'}
        ]
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    const anthropic = renderCanonicalToAnthropic(session);

    assert.deepEqual(
        anthropic.messages[1].content.map((block) => block.type),
        ['text', 'tool_use']
    );
    assert.equal(
        anthropic.messages[1].content.some((block) => block.type === 'thinking'),
        false
    );
});

test('canonical session maps Anthropic tool_use_id to every renderer', () => {
    const session = canonicalFromAnthropicRequest({
        model: 'claude-test',
        system: 'Be concise.',
        messages: [
            {role: 'user', content: [{type: 'text', text: 'Read README'}]},
            {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'Need file contents.', signature: 'sig_1'},
                    {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {path: 'README.md'}}
                ]
            },
            {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: 'README text'}]}
        ],
        tools: [{name: 'read_file', input_schema: {type: 'object'}}]
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    assert.equal(session.toolMappings[0].anthropicToolUseId, 'toolu_1');

    const anthropic = renderCanonicalToAnthropic(session);
    assert.equal(anthropic.messages[1].content[1].id, 'toolu_1');
    assert.equal(anthropic.messages[2].content[0].tool_use_id, 'toolu_1');

    const chat = renderCanonicalToChat(session);
    assert.equal(chat.messages[2].tool_calls[0].id, 'toolu_1');
    assert.equal(chat.messages[3].tool_call_id, 'toolu_1');
});

test('canonical session can describe an Anthropic stream emitted as Chat chunks', () => {
    const session = canonicalFromAnthropicStreamChatResponse({
        id: 'chatcmpl_stream_1',
        model: 'claude-test',
        choices: [{
            message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'toolu_stream_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }]
    }, {tenantId: 'tenant-a', conversationKey: 'conv-a'});

    assert.equal(session.sourceProtocol, 'anthropic');
    assert.equal(session.toolMappings[0].anthropicToolUseId, 'toolu_stream_1');
    assert.equal(session.toolMappings[0].openAIChatToolCallId, null);

    const anthropic = renderCanonicalToAnthropic(session);
    assert.equal(anthropic.messages[0].content[0].id, 'toolu_stream_1');
});

test('canonical session preserves image and file content blocks', () => {
    const session = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [{
            role: 'user',
            content: [
                {type: 'text', text: 'inspect these'},
                {type: 'image_url', image_url: {url: 'https://example.test/image.png'}},
                {type: 'file', file: {filename: 'report.txt', file_data: 'base64-file-data'}}
            ]
        }]
    });

    assert.deepEqual(session.turns[0].blocks, [
        {type: 'text', text: 'inspect these'},
        {type: 'image', url: 'https://example.test/image.png'},
        {type: 'file', filename: 'report.txt', dataRef: 'base64-file-data'}
    ]);

    const responses = renderCanonicalToResponses(session);
    assert.deepEqual(responses.input[0].content, [
        {type: 'input_text', text: 'inspect these'},
        {type: 'input_image', image_url: 'https://example.test/image.png'},
        {type: 'input_file', file_data: 'base64-file-data'}
    ]);
});

test('canonical renderers normalize tool definitions and tool choice for target protocols', () => {
    const chatSession = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [{role: 'user', content: 'list files'}],
        tools: [{
            type: 'function',
            function: {
                name: 'list_files',
                description: 'List files',
                parameters: {type: 'object', properties: {path: {type: 'string'}}}
            }
        }],
        tool_choice: {type: 'function', function: {name: 'list_files'}},
        parallel_tool_calls: false
    });

    const anthropic = renderCanonicalToAnthropic(chatSession);
    assert.deepEqual(anthropic.tools, [{
        name: 'list_files',
        description: 'List files',
        input_schema: {type: 'object', properties: {path: {type: 'string'}}}
    }]);
    assert.deepEqual(anthropic.tool_choice, {type: 'tool', name: 'list_files'});

    const anthropicSession = canonicalFromAnthropicRequest({
        model: 'claude-test',
        messages: [{role: 'user', content: [{type: 'text', text: 'list files'}]}],
        tools: [{
            name: 'list_files',
            description: 'List files',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}}
        }],
        tool_choice: {type: 'tool', name: 'list_files'}
    });

    const chat = renderCanonicalToChat(anthropicSession);
    assert.deepEqual(chat.tools, [{
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files',
            parameters: {type: 'object', properties: {path: {type: 'string'}}}
        }
    }]);
    assert.deepEqual(chat.tool_choice, {type: 'function', function: {name: 'list_files'}});

    const responses = renderCanonicalToResponses(anthropicSession);
    assert.deepEqual(responses.tools, [{
        type: 'function',
        name: 'list_files',
        description: 'List files',
        parameters: {type: 'object', properties: {path: {type: 'string'}}}
    }]);
    assert.deepEqual(responses.tool_choice, {type: 'function', name: 'list_files'});
});

test('renderCanonicalToAnthropic converts data URL image to base64 source instead of url source', () => {
    const session = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [{
            role: 'user',
            content: [
                {type: 'text', text: 'describe this'},
                {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}
            ]
        }]
    });

    const anthropic = renderCanonicalToAnthropic(session);
    const image = anthropic.messages[0].content.find((block) => block.type === 'image');
    assert.deepEqual(image.source, {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='});
});

test('renderCanonicalToChat and renderCanonicalToResponses prefix bare dataRef image with data URL', () => {
    const session = {
        turns: [{
            role: 'user',
            blocks: [{type: 'image', mediaType: 'image/jpeg', dataRef: 'cmF3YmFzZQ=='}]
        }],
        toolMappings: []
    };

    const chat = renderCanonicalToChat(session);
    assert.deepEqual(chat.messages[0].content, [
        {type: 'image_url', image_url: {url: 'data:image/jpeg;base64,cmF3YmFzZQ=='}}
    ]);

    const responses = renderCanonicalToResponses(session);
    assert.deepEqual(responses.input[0].content, [
        {type: 'input_image', image_url: 'data:image/jpeg;base64,cmF3YmFzZQ=='}
    ]);
});

test('renderCanonicalToResponses extracts tool_result image into a separate user input item', () => {
    const session = canonicalFromAnthropicRequest({
        model: 'claude-test',
        messages: [
            {role: 'user', content: 'read the screenshot'},
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_image', input: {path: 'a.png'}}]},
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: [
                        {type: 'text', text: 'screenshot captured'},
                        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
                    ]
                }]
            }
        ]
    });

    const responses = renderCanonicalToResponses(session);
    const fco = responses.input.find((item) => item.type === 'function_call_output');
    assert.equal(fco.output, 'screenshot captured');
    const userImage = responses.input.find((item) => item.role === 'user' && Array.isArray(item.content) && item.content.some((p) => p.type === 'input_image'));
    assert.ok(userImage, 'expected a user input item carrying the extracted image');
    assert.deepEqual(userImage.content, [
        {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='}
    ]);
});

test('renderCanonicalToChat renders tool_result image as image_url array', () => {
    const session = canonicalFromAnthropicRequest({
        model: 'claude-test',
        messages: [
            {role: 'user', content: 'read the screenshot'},
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_image', input: {path: 'a.png'}}]},
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: [
                        {type: 'text', text: 'screenshot captured'},
                        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
                    ]
                }]
            }
        ]
    });

    const chat = renderCanonicalToChat(session);
    const toolMessage = chat.messages.find((m) => m.role === 'tool');
    assert.deepEqual(toolMessage.content, [
        {type: 'text', text: 'screenshot captured'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}
    ]);
});

test('renderCanonicalToAnthropic renders tool_result image as inline image block on Chat-origin roundtrip', () => {
    const session = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_chat_1',
                    type: 'function',
                    function: {name: 'read_image', arguments: '{"path":"a.png"}'}
                }]
            },
            {
                role: 'tool',
                tool_call_id: 'call_chat_1',
                content: [
                    {type: 'text', text: 'screenshot captured'},
                    {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}
                ]
            }
        ]
    });

    const anthropic = renderCanonicalToAnthropic(session);
    const toolResult = anthropic.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block?.type === 'tool_result');
    assert.ok(toolResult, 'expected a tool_result block');
    assert.deepEqual(toolResult.content, [
        {type: 'text', text: 'screenshot captured'},
        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
    ]);
});

test('renderCanonicalToAnthropic keeps tool_result image as native block when Anthropic content is relayed', () => {
    const session = canonicalFromAnthropicRequest({
        model: 'claude-test',
        messages: [
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_image', input: {}}]},
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: [
                        {type: 'text', text: 'screenshot captured'},
                        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
                    ]
                }]
            }
        ]
    });

    const anthropic = renderCanonicalToAnthropic(session);
    const toolResult = anthropic.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block?.type === 'tool_result');
    assert.deepEqual(toolResult.content, [
        {type: 'text', text: 'screenshot captured'},
        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
    ]);
});

test('renderCanonicalToAnthropic merges text-only tool_result content into scalar string', () => {
    const session = canonicalFromChatRequest({
        model: 'gpt-test',
        messages: [
            {
                role: 'assistant',
                content: '',
                tool_calls: [{id: 'call_chat_1', type: 'function', function: {name: 'grep', arguments: '{}'}}]
            },
            {
                role: 'tool',
                tool_call_id: 'call_chat_1',
                content: [{type: 'text', text: 'line 1'}, {type: 'text', text: 'line 2'}]
            }
        ]
    });

    const anthropic = renderCanonicalToAnthropic(session);
    const toolResult = anthropic.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block?.type === 'tool_result');
    assert.equal(toolResult.content, 'line 1\nline 2');
});
