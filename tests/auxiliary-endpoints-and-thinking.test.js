import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {
    openAIToAnthropic,
    sanitizeAnthropicPayload,
    sanitizeAnthropicMessages
} from '../src/transformer/shared-translator.js';
import {anthropicToOpenAI as copilotAnthropicToOpenAI} from '../src/services/copilot/anthropic-translator.js';
import {
    createStreamState as createCopilotStreamState,
    translateStreamChunk as translateCopilotStreamChunk
} from '../src/services/copilot/anthropic-translator.js';
import {anthropicToOpenAI as relayAnthropicToOpenAI} from '../src/services/relay/translator.js';
import {ClaudeStreamState as RelayClaudeStreamState} from '../src/services/relay/translator.js';
import {anthropicToOpenAI as codebuddyAnthropicToOpenAI} from '../src/services/codebuddy/translator.js';
import {
    ClaudeStreamState as CodebuddyClaudeStreamState,
    createStreamState as createCodebuddyStreamState,
    translateStreamChunk as translateCodebuddyStreamChunk
} from '../src/services/codebuddy/translator.js';
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

test('anthropic translators keep tool_use-only assistant content as empty string', () => {
    for (const convert of [copilotAnthropicToOpenAI, relayAnthropicToOpenAI, codebuddyAnthropicToOpenAI]) {
        const converted = convert({
            model: 'claude-sonnet-4',
            max_tokens: 128,
            messages: [{
                role: 'assistant',
                content: [
                    {type: 'thinking', thinking: 'need tool'},
                    {type: 'tool_use', id: 'call_1', name: 'read_file', input: {path: 'README.md'}}
                ]
            }]
        });

        const assistant = converted.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.content, '');
        assert.equal(assistant.reasoning_content, 'need tool');
        assert.equal(assistant.tool_calls[0].id, 'call_1');
    }
});

test('openAIToAnthropic returns reasoning_content as a thinking block', () => {
    const converted = openAIToAnthropic({
        id: 'chatcmpl_1',
        model: 'kimi-k2.6',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                reasoning_content: 'check the file first',
                content: 'I will read it.',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: {prompt_tokens: 10, completion_tokens: 5}
    });

    assert.deepEqual(converted.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
    assert.equal(converted.content[0].thinking, 'check the file first');
});

test('openAIToAnthropic splits cached prompt tokens from Anthropic input_tokens', () => {
    const converted = openAIToAnthropic({
        id: 'chatcmpl_1',
        model: 'kimi-k2.6',
        choices: [{
            index: 0,
            message: {role: 'assistant', content: 'ok'},
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            prompt_tokens_details: {cached_tokens: 300, cache_creation_tokens: 200}
        }
    });

    assert.equal(converted.usage.input_tokens, 500);
    assert.equal(converted.usage.cache_read_input_tokens, 300);
    assert.equal(converted.usage.cache_creation_input_tokens, 200);
    assert.equal(converted.usage.output_tokens, 5);
});

test('OpenAI to Anthropic stream chunks transmit complete split usage fields', () => {
    const chunk = {
        id: 'chatcmpl_1',
        model: 'kimi-k2.6',
        choices: [{
            index: 0,
            delta: {content: 'ok'},
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: 1000,
            completion_tokens: 5,
            prompt_tokens_details: {cached_tokens: 300, cache_creation_tokens: 200}
        }
    };

    for (const [createState, translateChunk] of [
        [createCopilotStreamState, translateCopilotStreamChunk],
        [createCodebuddyStreamState, translateCodebuddyStreamChunk]
    ]) {
        const events = translateChunk(chunk, createState());
        const messageStart = events.find(event => event.type === 'message_start');
        const messageDelta = events.find(event => event.type === 'message_delta');

        assert.deepEqual(messageStart.message.usage, {
            input_tokens: 500,
            output_tokens: 0,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 200
        });
        assert.deepEqual(messageDelta.usage, {
            input_tokens: 500,
            output_tokens: 5,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 200
        });
    }
});

test('Claude stream states transmit zero-valued cache usage fields', () => {
    for (const StateClass of [RelayClaudeStreamState, CodebuddyClaudeStreamState]) {
        const events = [];
        const state = new StateClass({write: (event, data) => events.push({event, data})});

        state.startMessage('claude-sonnet-4');
        state.endMessage('end_turn');

        const start = events.find(item => item.event === 'message_start');
        const delta = events.find(item => item.event === 'message_delta');

        assert.deepEqual(start.data.message.usage, {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        });
        assert.deepEqual(delta.data.usage, {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
        });
    }
});

test('Responses fallback completed events transmit cache usage details', () => {
    for (const file of ['src/routes/codebuddy.js', 'src/routes/copilot.js']) {
        const source = readFileSync(join(root, file), 'utf8');
        assert.match(source, /input_tokens_details:\s*\{\s*cached_tokens:\s*streamCacheHitTokens,\s*cache_creation_tokens:\s*streamCacheCreationTokens\s*\}/);
    }
});

test('chatRequestToAnthropic moves preceding tool result after assistant tool_use', () => {
    const converted = chatRequestToAnthropic({
        model: 'claude-sonnet-4',
        messages: [
            {role: 'user', content: 'Read README.md'},
            {role: 'tool', tool_call_id: 'call_1', content: 'README contents'},
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            {role: 'user', content: 'Continue'}
        ]
    });

    assert.equal(converted.messages[0].role, 'user');
    assert.equal(converted.messages[1].role, 'assistant');
    assert.equal(converted.messages[1].content[0].type, 'tool_use');
    assert.equal(converted.messages[2].role, 'user');
    assert.equal(converted.messages[2].content[0].type, 'tool_result');
    assert.equal(converted.messages[2].content[0].tool_use_id, 'call_1');
    assert.equal(converted.messages[3].role, 'user');
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

test('relay Responses-capable passthrough paths remember visible input before completion', () => {
    const source = readFileSync(join(root, 'src/routes/relay.js'), 'utf8');
    const prepareCalls = source.match(/prepareResponsesPassthrough/g) || [];

    assert.equal(prepareCalls.length >= 4, true);
});

test('relay Responses passthrough paths limit oversized input before upstream transport', () => {
    const source = readFileSync(join(root, 'src/routes/relay.js'), 'utf8');
    const limitCalls = source.match(/limitResponsesPassthroughPayload/g) || [];

    assert.equal(limitCalls.length >= 5, true);
    assert.match(source, /lastResponseId/);
});
