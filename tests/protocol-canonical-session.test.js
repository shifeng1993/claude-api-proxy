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

test('canonical session maps Anthropic tool_use_id to every renderer', () => {
    const session = canonicalFromAnthropicRequest({
        model: 'claude-test',
        system: 'Be concise.',
        messages: [
            {role: 'user', content: [{type: 'text', text: 'Read README'}]},
            {
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'Need file contents.'},
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
