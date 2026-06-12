import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {
    sanitizeAnthropicPayload,
    sanitizeAnthropicMessages
} from '../src/transformer/shared-translator.js';
import {anthropicToOpenAI as copilotAnthropicToOpenAI} from '../src/services/copilot/anthropic-translator.js';
import {
    anthropicResponseToChat,
    chatRequestToAnthropic
} from '../src/routes/relay-protocol-converters.js';

const root = process.cwd();

test('sanitizes volatile Anthropic thinking fields without touching text', () => {
    const payload = sanitizeAnthropicPayload({
        model: 'claude-sonnet-4',
        messages: [{
            role: 'assistant',
            content: [
                {type: 'thinking', thinking: 'stable reasoning', signature: 'sig', tokens: 12, usage: {output_tokens: 12}},
                {type: 'redacted_thinking', data: 'abc', tokens: 3},
                {type: 'text', text: 'answer', cache_control: {type: 'ephemeral'}}
            ]
        }]
    });

    assert.deepEqual(payload.messages[0].content[0], {
        type: 'thinking',
        thinking: 'stable reasoning',
        signature: 'sig'
    });
    assert.deepEqual(payload.messages[0].content[1], {
        type: 'redacted_thinking',
        data: 'abc'
    });
    assert.deepEqual(payload.messages[0].content[2], {
        type: 'text',
        text: 'answer',
        cache_control: {type: 'ephemeral'}
    });
});

test('sanitizeAnthropicMessages tolerates non-array input', () => {
    assert.equal(sanitizeAnthropicMessages(null), null);
    assert.equal(sanitizeAnthropicMessages('x'), 'x');
});

test('copilot keeps historical thinking separate from assistant content', () => {
    const converted = copilotAnthropicToOpenAI({
        model: 'claude-sonnet-4',
        max_tokens: 128,
        messages: [{
            role: 'assistant',
            content: [
                {type: 'thinking', thinking: 'hidden chain'},
                {type: 'text', text: 'visible answer'}
            ]
        }]
    });

    const assistant = converted.messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content, 'visible answer');
    assert.equal(assistant.reasoning_content, 'hidden chain');
});

test('all service routes keep Anthropic endpoints out of OpenAI namespace', () => {
    const routeFiles = [
        ['relay', 'src/routes/relay.js'],
        ['codebuddy', 'src/routes/codebuddy.js'],
        ['copilot', 'src/routes/copilot.js']
    ];

    for (const [service, file] of routeFiles) {
        const source = readFileSync(join(root, file), 'utf8');
        assert.match(source, new RegExp(`/${service}/anthropic/v1/messages`));
        assert.match(source, new RegExp(`/${service}/anthropic/v1/messages/count_tokens`));
        assert.doesNotMatch(source, new RegExp(`/${service}/v1/messages'`));
        assert.doesNotMatch(source, new RegExp(`/${service}/v1/messages/count_tokens'`));
        assert.doesNotMatch(source, new RegExp(`/${service}/v1/usage'`));
        assert.doesNotMatch(source, /wantsAnthropicFormat\(req\)/);
        assert.match(source, /sanitizeAnthropicPayload\(JSON\.parse\(body\)\)/);
    }
});

test('OpenAI Responses stream fallback returns buffered output', () => {
    for (const file of ['src/routes/relay.js', 'src/routes/codebuddy.js', 'src/routes/copilot.js']) {
        const source = readFileSync(join(root, file), 'utf8');
        assert.match(source, /if \(!streamState\.started \|\| !streamState\.finished\)/);
        assert.match(source, /output: streamState\.output/);
    }
});

test('relay protocol converters preserve tools and cache usage across Chat and Anthropic', () => {
    const anthropicReq = chatRequestToAnthropic({
        model: 'claude-sonnet-4',
        stream: false,
        messages: [
            {role: 'system', content: 'be concise'},
            {role: 'user', content: 'list files'},
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'list_files', arguments: '{"path":"."}'}
                }]
            },
            {role: 'tool', tool_call_id: 'call_1', content: 'README.md'}
        ],
        tools: [{
            type: 'function',
            function: {name: 'list_files', description: 'List files', parameters: {type: 'object'}}
        }],
        tool_choice: {type: 'function', function: {name: 'list_files'}}
    });

    assert.equal(anthropicReq.system, 'be concise');
    assert.equal(anthropicReq.tools[0].name, 'list_files');
    assert.deepEqual(anthropicReq.tool_choice, {type: 'tool', name: 'list_files'});
    assert.equal(anthropicReq.messages[1].content[0].type, 'tool_use');
    assert.deepEqual(anthropicReq.messages[1].content[0].input, {path: '.'});
    assert.equal(anthropicReq.messages[2].content[0].type, 'tool_result');

    const chatRes = anthropicResponseToChat({
        id: 'msg_1',
        model: 'claude-sonnet-4',
        stop_reason: 'tool_use',
        content: [
            {type: 'thinking', thinking: 'check cwd'},
            {type: 'text', text: 'I will list files.'},
            {type: 'tool_use', id: 'call_2', name: 'list_files', input: {path: 'src'}}
        ],
        usage: {input_tokens: 12, cache_read_input_tokens: 5, output_tokens: 7}
    });

    assert.equal(chatRes.choices[0].finish_reason, 'tool_calls');
    assert.equal(chatRes.choices[0].message.content, 'I will list files.');
    assert.equal(chatRes.choices[0].message.reasoning_content, 'check cwd');
    assert.equal(chatRes.choices[0].message.tool_calls[0].function.arguments, '{"path":"src"}');
    assert.equal(chatRes.usage.prompt_tokens_details.cached_tokens, 5);
});

test('relay routes expose cross-protocol bridges without protocol mismatch rejects', () => {
    const source = readFileSync(join(root, 'src/routes/relay.js'), 'utf8');

    for (const requestType of [
        'ChatCompletionsViaAnthropic',
        'AnthropicViaResponsesWebSocket',
        'AnthropicViaResponses',
        'ResponsesViaAnthropic',
        'ResponsesCompactViaAnthropic',
        'ResponsesWSViaAnthropic'
    ]) {
        assert.match(source, new RegExp(requestType));
    }

    assert.doesNotMatch(source, /getProtocolErrorMessage\(upstream, 'anthropic', '\/relay\/v1\/responses'\)/);
    assert.doesNotMatch(source, /getProtocolErrorMessage\(upstream, 'responses', '\/relay\/anthropic\/v1\/messages'\)/);
});
