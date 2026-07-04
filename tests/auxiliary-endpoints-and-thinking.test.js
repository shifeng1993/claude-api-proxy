import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';
import {
    openAIToAnthropic,
    sanitizeAnthropicPayload,
    sanitizeAnthropicMessages
} from '../src/protocol-engine/core/shared.js';
import {anthropicToOpenAI as relayAnthropicToOpenAI} from '../src/services/relay/anthropic-adapter.js';
import {anthropicToOpenAI as codebuddyAnthropicToOpenAI} from '../src/services/codebuddy/anthropic-adapter.js';
import {createChatToAnthropicStreamBridge} from '../src/protocol-engine/core/stream/canonical-stream.js';
import {
    anthropicResponseToChat,
    chatResponseToAnthropic,
    chatResponseToRelayResponses,
    chatRequestToAnthropic,
    chatRequestToRelayResponses,
    responsesResponseToRelayChat
} from '../src/protocol-engine/core/http-converters.js';

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

test('anthropic adapters keep tool_use-only assistant content as empty string', () => {
    for (const convert of [relayAnthropicToOpenAI, codebuddyAnthropicToOpenAI]) {
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

test('openAIToAnthropic exposes unsigned reasoning_content as Anthropic thinking with placeholder signature', () => {
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
    const thinking = converted.content.find((block) => block.type === 'thinking');
    assert.equal(thinking.thinking, 'check the file first');
    assert.ok(thinking.signature);
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
            prompt_tokens_details: {cached_tokens: 300}
        }
    });

    assert.equal(converted.usage.input_tokens, 700);
    assert.equal(converted.usage.cache_read_input_tokens, 300);
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
            prompt_tokens_details: {cached_tokens: 300}
        }
    };

    const bridge = createChatToAnthropicStreamBridge({model: 'kimi-k2.6'});
    const events = bridge.feed(chunk);
    const messageStart = events.find(event => event.type === 'message_start');
    const messageDelta = events.find(event => event.type === 'message_delta');

    assert.deepEqual(messageStart.message.usage, {
        input_tokens: 700,
        output_tokens: 0,
        cache_read_input_tokens: 300
    });
    assert.deepEqual(messageDelta.usage, {
        input_tokens: 700,
        output_tokens: 5,
        cache_read_input_tokens: 300
    });
});

test('canonical Chat to Anthropic stream transmits zero-valued cache usage fields', () => {
    const bridge = createChatToAnthropicStreamBridge({model: 'claude-sonnet-4'});
    const events = bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-sonnet-4',
        choices: [{
            index: 0,
            delta: {role: 'assistant'},
            finish_reason: 'stop'
        }]
    });

    const start = events.find(event => event.type === 'message_start');
    const delta = events.find(event => event.type === 'message_delta');

    assert.deepEqual(start.message.usage, {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0
    });
    assert.deepEqual(delta.usage, {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0
    });
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
        ['relay', [
            'src/routes/relay.js',
            'src/services/relay/protocols/anthropic/messages.js'
        ]],
        ['codebuddy', [
            'src/routes/codebuddy.js',
            'src/services/codebuddy/route-runtime.js',
            'src/services/codebuddy/metadata-handler.js'
        ]]
    ];

    for (const [service, files] of routeFiles) {
        const source = files
            .map((file) => readFileSync(join(root, file), 'utf8'))
            .join('\n');
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
    const relaySource = [
        'src/routes/relay.js',
        'src/services/relay/protocols/responses/http.js'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
    assert.match(relaySource, /if \(!chatToResponsesBridge\.finished\)/);
    assert.match(relaySource, /chatToResponsesBridge\.finish\(\)/);
    assert.match(relaySource, /responsesAccumulator\.feed\(ev\.event,\s*ev\.data\)/);

    const codebuddySource = [
        'src/routes/codebuddy.js',
        'src/services/codebuddy/protocols/responses/http.js',
        'src/services/codebuddy/protocols/responses/websocket.js'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
    assert.match(codebuddySource, /if \(!chatToResponsesBridge\.finished\)/);
    assert.match(codebuddySource, /chatToResponsesBridge\.finish\(\)/);
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

test('anthropicResponseToChat preserves image blocks through canonical rendering', () => {
    const chatRes = anthropicResponseToChat({
        id: 'msg_image',
        model: 'claude-sonnet-4',
        stop_reason: 'end_turn',
        content: [
            {type: 'text', text: 'see image'},
            {type: 'image', source: {type: 'url', url: 'https://example.test/out.png'}}
        ],
        usage: {input_tokens: 1, output_tokens: 2}
    });

    assert.deepEqual(chatRes.choices[0].message.content, [
        {type: 'text', text: 'see image'},
        {type: 'image_url', image_url: {url: 'https://example.test/out.png'}}
    ]);
});

test('chatResponseToAnthropic preserves file blocks through canonical rendering', () => {
    const anthropicRes = chatResponseToAnthropic({
        id: 'chatcmpl_file',
        model: 'gpt-test',
        choices: [{
            message: {
                role: 'assistant',
                content: [
                    {type: 'text', text: 'report ready'},
                    {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
                ]
            },
            finish_reason: 'stop'
        }],
        usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3}
    });

    assert.deepEqual(anthropicRes.content, [
        {type: 'text', text: 'report ready'},
        {type: 'text', text: 'report.txt'}
    ]);
});

test('responsesResponseToRelayChat preserves file blocks through canonical rendering', () => {
    const chatRes = responsesResponseToRelayChat({
        id: 'resp_file',
        model: 'gpt-test',
        output: [{
            type: 'message',
            role: 'assistant',
            content: [
                {type: 'output_text', text: 'report ready'},
                {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
            ]
        }],
        usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}
    });

    assert.deepEqual(chatRes.choices[0].message.content, [
        {type: 'text', text: 'report ready'},
        {type: 'file', file: 'base64-report'}
    ]);
});

test('chatResponseToRelayResponses preserves file blocks through canonical rendering', () => {
    const responsesRes = chatResponseToRelayResponses({
        id: 'chatcmpl_file',
        model: 'gpt-test',
        choices: [{
            message: {
                role: 'assistant',
                content: [
                    {type: 'text', text: 'report ready'},
                    {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
                ]
            },
            finish_reason: 'stop'
        }],
        usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3}
    });

    assert.deepEqual(responsesRes.output[0].content, [
        {type: 'output_text', text: 'report ready'},
        {type: 'input_file', file_data: 'base64-report'}
    ]);
});

test('chatRequestToRelayResponses preserves file blocks through canonical rendering', () => {
    const responsesReq = chatRequestToRelayResponses({
        model: 'gpt-test',
        messages: [{
            role: 'user',
            content: [
                {type: 'text', text: 'inspect this file'},
                {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
            ]
        }],
        max_tokens: 123,
        response_format: {type: 'json_object'}
    });

    assert.deepEqual(responsesReq.input[0].content, [
        {type: 'input_text', text: 'inspect this file'},
        {type: 'input_file', file_data: 'base64-report'}
    ]);
    assert.equal(responsesReq.max_output_tokens, 123);
    assert.deepEqual(responsesReq.text, {format: {type: 'json_object'}});
});

test('chatRequestToAnthropic preserves file blocks through canonical rendering', () => {
    const anthropicReq = chatRequestToAnthropic({
        model: 'claude-sonnet-4',
        messages: [{
            role: 'user',
            content: [
                {type: 'text', text: 'inspect this file'},
                {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
            ]
        }]
    });

    assert.deepEqual(anthropicReq.messages[0].content, [
        {type: 'text', text: 'inspect this file'},
        {type: 'text', text: 'report.txt'}
    ]);
});

test('relay routes expose cross-protocol bridges without protocol mismatch rejects', () => {
    const source = [
        'src/routes/relay.js',
        'src/services/relay/protocols/chat/completions.js',
        'src/services/relay/protocols/anthropic/messages.js',
        'src/services/relay/protocols/responses/http.js',
        'src/services/relay/protocols/responses/compact.js',
        'src/services/relay/protocols/responses/websocket.js'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

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

test('relay Responses passthrough paths route visible input through continuation state', () => {
    const responsesApi = readFileSync(join(root, 'src/services/relay/protocols/responses/http.js'), 'utf8');
    const responsesWs = readFileSync(join(root, 'src/services/relay/protocols/responses/websocket.js'), 'utf8');
    const continuation = readFileSync(join(root, 'src/services/session/responses-continuation.js'), 'utf8');

    assert.match(responsesApi, /prepareResponsesContinuationPayload\(\{\s*conversationStore: relayConversationStore/s);
    assert.match(responsesWs, /prepareResponsesContinuationPayload\(\{\s*conversationStore: relayConversationStore/s);
    assert.match(continuation, /conversationStore\.prepareResponsesPassthrough\(\{/);
});

test('relay Responses passthrough paths apply continuation limit before upstream transport', () => {
    const responsesApi = readFileSync(join(root, 'src/services/relay/protocols/responses/http.js'), 'utf8');
    const responsesWs = readFileSync(join(root, 'src/services/relay/protocols/responses/websocket.js'), 'utf8');
    const continuation = readFileSync(join(root, 'src/services/session/responses-continuation.js'), 'utf8');

    assert.doesNotMatch(responsesApi, /limitResponsesPassthroughPayload/);
    assert.doesNotMatch(responsesWs, /limitResponsesPassthroughPayload/);
    assert.match(continuation, /limitResponsesInputItems\(outboundRequest, \{previousResponseId\}\)/);
    assert.match(continuation, /lastResponseId/);
});

test('relay Anthropic passthrough non-stream stats use split input token helper', () => {
    const source = readFileSync(join(root, 'src/services/relay/protocols/anthropic/messages.js'), 'utf8');

    assert.match(
        source,
        /recordUsage\(\s*tenantId,\s*extractInputTokens\(parsed\.usage\)\s*\|\|\s*estimateAnthropicInputTokens\(anthropicPayload\),\s*parsed\.usage\?\.output_tokens/
    );
});

test('relay Anthropic stream stats keep the maximum cache hit tokens across usage events', () => {
    const source = readFileSync(join(root, 'src/services/relay/anthropic-usage.js'), 'utf8');

    assert.match(
        source,
        /usageState\.cacheHitTokens\s*=\s*Math\.max\(\s*usageState\.cacheHitTokens,\s*extractCacheHitTokens\(usage\)\s*\)/
    );
});

test('relay Chat handler does not reference Anthropic payload before it is created', () => {
    const source = readFileSync(join(root, 'src/services/relay/protocols/chat/completions.js'), 'utf8');
    const start = source.indexOf('async function handleOpenAIChatCompletions');
    const end = source.indexOf("if (isResponsesWebSocketUpstream(upstream))", start);
    const handler = source.slice(start, end);

    const anthropicPayloadIndex = handler.indexOf('const anthropicPayload = chatRequestToAnthropic');
    const earlyHandler = handler.slice(0, anthropicPayloadIndex);

    assert.ok(anthropicPayloadIndex > -1);
    assert.equal(earlyHandler.includes('canonicalFromAnthropicRequest(anthropicPayload'), false);
});

test('relay Anthropic passthrough stream records accumulated response into session', () => {
    const source = readFileSync(join(root, 'src/services/relay/protocols/anthropic/messages.js'), 'utf8');

    assert.match(source, /const anthropicAccumulator = createAnthropicStreamAccumulator/);
    assert.match(source, /anthropicAccumulator\.feed\(event, parsed\)/);
    assert.match(
        source,
        /relayConversationStore\.recordAnthropicResponse\(\{\s*tenantId,\s*conversationKey: baseConversationKey,\s*response: anthropicResponse,/s
    );
});

test('relay Anthropic via Chat stream records accumulated chat response into session', () => {
    const source = readFileSync(join(root, 'src/services/relay/protocols/anthropic/messages.js'), 'utf8');
    const requestTypeIndex = source.indexOf("requestType: 'Anthropic'");
    const start = source.lastIndexOf("if (anthropicPayload.stream) {", requestTypeIndex);
    const end = source.indexOf('} else {', requestTypeIndex);
    const streamBranch = source.slice(start, end);

    assert.ok(requestTypeIndex > -1);
    assert.ok(start > -1);
    assert.ok(end > start);
    assert.match(streamBranch, /const chatAccumulator = createChatStreamAccumulator/);
    assert.match(streamBranch, /chatAccumulator\.feed\(data\)/);
    assert.match(
        streamBranch,
        /relayConversationStore\.recordChatResponse\(\{\s*tenantId,\s*conversationKey,\s*response: chatResponse/s
    );
});

test('relay OpenAI passthrough stream records accumulated chat response into session', () => {
    const source = readFileSync(join(root, 'src/services/relay/openai-stream.js'), 'utf8');

    assert.match(source, /function streamRelayOpenAIPassthrough/);
    assert.match(source, /const chatAccumulator = createChatStreamAccumulator/);
    assert.match(source, /chatAccumulator\.feed\(chunk\)/);
    assert.match(source, /conversationStore\?\.recordChatResponse\?\.\(\{/);
});

test('relay Responses output streams record accumulated responses when completed is missing', () => {
    const source = [
        'src/routes/relay.js',
        'src/services/relay/protocols/chat/completions.js',
        'src/services/relay/protocols/responses/websocket.js'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    assert.match(source, /createResponsesStreamAccumulator/);
    assert.match(source, /responsesAccumulator\.feed\(ev\.event,\s*ev\.data\)/);
    assert.match(source, /responsesAccumulator\.feed\(event\.type,\s*event\.data\)/);
    assert.match(source, /responsesAccumulator\.feed\(eventType,\s*parsed\)/);
    assert.match(source, /completedResponse\s*\|\|\s*responsesAccumulator\.toResponsesResponse\(\)/);
});

test('stream routes use canonical bridge wiring without legacy state machines', () => {
    const cases = [
        {
            name: 'relay Responses to Chat',
            file: 'src/services/relay/protocols/chat/completions.js',
            present: [
                /createResponsesToChatStreamBridge/,
                /responsesToChatBridge\.feed\(event\.type,\s*event\.data\)/,
                /responsesToChatBridge\.feed\(eventType,\s*parsed\)/
            ],
            absent: [/responsesEventToChatChunks\(/]
        },
        {
            name: 'relay Chat to Responses',
            file: 'src/services/relay/protocols/responses/websocket.js',
            present: [
                /createChatToResponsesStreamBridge/,
                /chatToResponsesBridge\.feed\(chatChunk\)/,
                /chatToResponsesBridge\.feed\(data\)/
            ],
            absent: [/chatChunkToResponsesEvents\(/]
        },
        {
            name: 'CodeBuddy Chat to Responses',
            file: 'src/services/codebuddy/protocols/responses/http.js',
            present: [/createChatToResponsesStreamBridge/, /chatToResponsesBridge\.feed\(data\)/],
            absent: [/chatChunkToResponsesEvents\(/]
        },
        {
            name: 'CodeBuddy Anthropic via Chat',
            file: 'src/services/codebuddy/protocols/anthropic/messages.js',
            present: [/createChatToAnthropicStreamBridge/, /chatToAnthropicBridge\.feed\(data\)/],
            absent: [/new ClaudeStreamState/, /new SSEWriter/]
        },
        {
            name: 'relay Chat to Anthropic',
            file: 'src/services/relay/anthropic-stream.js',
            present: [/createChatToAnthropicStreamBridge/, /chatToAnthropicBridge\.feed\(chatChunk\)/],
            absent: [/chatChunkToAnthropicEvents\(/]
        },
        {
            name: 'relay Anthropic via Chat',
            file: 'src/services/relay/protocols/anthropic/messages.js',
            present: [/chatToAnthropicBridge\.feed\(data\)/],
            absent: [/new ClaudeStreamState/, /new SSEWriter/]
        },
        {
            name: 'relay Anthropic to Chat',
            file: 'src/services/relay/protocols/chat/completions.js',
            present: [/streamAnthropicSSEToChatChunks/],
            absent: [/anthropicStreamToChatChunks\(/]
        },
        {
            name: 'relay Responses to Responses',
            file: 'src/services/relay/protocols/responses/http.js',
            present: [/createResponsesToResponsesStreamBridge/],
            absent: [/responsesEventToResponsesEvents\(/]
        }
    ];

    const sources = new Map();
    for (const {name, file, present, absent} of cases) {
        if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), 'utf8'));
        const source = sources.get(file);
        for (const pattern of present) {
            assert.match(source, pattern, `${name} should include ${pattern}`);
        }
        for (const pattern of absent) {
            assert.doesNotMatch(source, pattern, `${name} should not include ${pattern}`);
        }
    }
});

test('legacy stream state machine exports stay out of product adapters', () => {
    const cases = [
        {
            file: 'src/protocol-engine/core/responses.js',
            absent: [
                /export function createResponsesStreamState/,
                /export function createChatCompletionsStreamState/,
                /export function responsesEventToResponsesEvents/,
                /export function responsesEventToChatChunks/,
                /export function chatChunkToResponsesEvents/
            ]
        },
        {
            file: 'src/services/relay/anthropic-adapter.js',
            absent: [
                /class SSEWriter/,
                /class ClaudeStreamState/,
                /export \{SSEWriter, ClaudeStreamState\}/,
                /export function createStreamState/,
                /export function translateStreamChunk/
            ]
        },
        {
            file: 'src/services/codebuddy/anthropic-adapter.js',
            absent: [
                /class SSEWriter/,
                /class ClaudeStreamState/,
                /export \{SSEWriter, ClaudeStreamState\}/,
                /export function createStreamState/,
                /export function translateStreamChunk/
            ]
        }
    ];

    for (const {file, absent} of cases) {
        const source = readFileSync(join(root, file), 'utf8');
        for (const pattern of absent) {
            assert.doesNotMatch(source, pattern, `${file} should not include ${pattern}`);
        }
    }
});
