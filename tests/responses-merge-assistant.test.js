import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeConsecutiveAssistantMessages, responsesRequestToChat, responsesResponseToChat} from '../src/protocol-engine/core/responses.js';

test('responsesRequestToChat merges consecutive assistant messages from output_text + function_call', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'What is the weather?'},
            {type: 'output_text', text: 'Let me check the weather.'},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny, 72°F'},
            {type: 'input_text', text: 'Thanks!'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'What is the weather?'},
        {role: 'assistant', content: 'Let me check the weather.', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{"city":"SF"}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 72°F'},
        {role: 'user', content: 'Thanks!'}
    ]);
});

test('responsesRequestToChat merges multiple function_calls into single assistant message', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'What is the weather and time?'},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}'},
            {type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{"tz":"PST"}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny'},
            {type: 'function_call_output', call_id: 'call_2', output: '3pm'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'What is the weather and time?'},
        {role: 'assistant', content: '', tool_calls: [
            {id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{"city":"SF"}'}},
            {id: 'call_2', type: 'function', function: {name: 'get_time', arguments: '{"tz":"PST"}'}}
        ]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny'},
        {role: 'tool', tool_call_id: 'call_2', content: '3pm'}
    ]);
});

test('responsesRequestToChat merges output_text + multiple function_calls', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'Check both'},
            {type: 'output_text', text: 'I will check both for you.'},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'},
            {type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny'},
            {type: 'function_call_output', call_id: 'call_2', output: '3pm'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'Check both'},
        {role: 'assistant', content: 'I will check both for you.', tool_calls: [
            {id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{}'}},
            {id: 'call_2', type: 'function', function: {name: 'get_time', arguments: '{}'}}
        ]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny'},
        {role: 'tool', tool_call_id: 'call_2', content: '3pm'}
    ]);
});

test('responsesRequestToChat does not merge non-consecutive assistant messages', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'Hello'},
            {type: 'output_text', text: 'Hi there!'},
            {type: 'input_text', text: 'How are you?'},
            {type: 'output_text', text: 'I am fine.'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'Hello'},
        {role: 'assistant', content: 'Hi there!'},
        {role: 'user', content: 'How are you?'},
        {role: 'assistant', content: 'I am fine.'}
    ]);
});

test('responsesRequestToChat handles multi-turn with tool calls correctly', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'What is the weather?'},
            {type: 'output_text', text: 'Let me check.'},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny'},
            {type: 'output_text', text: 'The weather is sunny!'},
            {type: 'input_text', text: 'And the time?'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'What is the weather?'},
        {role: 'assistant', content: 'Let me check.', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny'},
        {role: 'assistant', content: 'The weather is sunny!'},
        {role: 'user', content: 'And the time?'}
    ]);
});

test('mergeConsecutiveAssistantMessages moves preceding tool result directly after assistant tool_calls', () => {
    const toolCall = {
        id: 'call_1',
        type: 'function',
        function: {name: 'read_file', arguments: '{"path":"README.md"}'}
    };
    const messages = [
        {role: 'user', content: 'Read README.md'},
        {role: 'tool', tool_call_id: 'call_1', content: 'README contents'},
        {role: 'assistant', content: '', tool_calls: [toolCall]},
        {role: 'user', content: 'Continue'}
    ];

    mergeConsecutiveAssistantMessages(messages);

    assert.deepEqual(messages, [
        {role: 'user', content: 'Read README.md'},
        {role: 'assistant', content: '', tool_calls: [toolCall]},
        {role: 'tool', tool_call_id: 'call_1', content: 'README contents'},
        {role: 'user', content: 'Continue'}
    ]);
});

test('mergeConsecutiveAssistantMessages normalizes assistant tool_calls content to empty string', () => {
    const toolCall = {
        id: 'call_1',
        type: 'function',
        function: {name: 'search', arguments: '{"query":"test"}'}
    };
    const messages = [
        {role: 'assistant', content: null, tool_calls: [toolCall]},
        {role: 'tool', tool_call_id: 'call_1', content: 'result'}
    ];

    mergeConsecutiveAssistantMessages(messages);

    assert.equal(messages[0].content, '');
});

// === DeepSeek reasoning_content tests ===

test('responsesRequestToChat converts reasoning items to assistant reasoning_content', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'What is the weather?'},
            {type: 'reasoning', id: 'rs_1', summary: [{type: 'summary_text', text: 'I need to check the weather.'}]},
            {type: 'output_text', text: 'Let me check.'},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'What is the weather?'},
        {role: 'assistant', reasoning_content: 'I need to check the weather.', content: 'Let me check.', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny'}
    ]);
});

test('responsesRequestToChat merges reasoning + function_call (no output_text)', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'Check weather'},
            {type: 'reasoning', summary: [{type: 'summary_text', text: 'Calling weather tool.'}]},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'Check weather'},
        {role: 'assistant', reasoning_content: 'Calling weather tool.', content: '', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny'}
    ]);
});

test('responsesRequestToChat preserves reasoning_content in full Codex multi-turn history', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'message', role: 'user', content: [{type: 'input_text', text: 'What is the weather in SF?'}]},
            {type: 'reasoning', id: 'rs_1', summary: [{type: 'summary_text', text: 'I need to call the weather tool.'}]},
            {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Let me check.'}]},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"location":"SF"}'},
            {type: 'function_call_output', call_id: 'call_1', output: 'Sunny, 72°F'},
            {type: 'reasoning', id: 'rs_2', summary: [{type: 'summary_text', text: 'Got the result.'}]},
            {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'The weather in SF is sunny!'}]},
            {type: 'message', role: 'user', content: [{type: 'input_text', text: 'And NYC?'}]}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'What is the weather in SF?'},
        {role: 'assistant', reasoning_content: 'I need to call the weather tool.', content: 'Let me check.', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{"location":"SF"}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 72°F'},
        {role: 'assistant', reasoning_content: 'Got the result.', content: 'The weather in SF is sunny!'},
        {role: 'user', content: 'And NYC?'}
    ]);
});

test('responsesRequestToChat handles reasoning with multiple summary parts', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'Hello'},
            {type: 'reasoning', summary: [
                {type: 'summary_text', text: 'First thought.'},
                {type: 'summary_text', text: 'Second thought.'}
            ]},
            {type: 'output_text', text: 'Hi!'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'Hello'},
        {role: 'assistant', reasoning_content: 'First thought.\nSecond thought.', content: 'Hi!'}
    ]);
});

test('responsesRequestToChat skips empty reasoning items', () => {
    const result = responsesRequestToChat({
        model: 'deepseek-chat',
        input: [
            {type: 'input_text', text: 'Hello'},
            {type: 'reasoning', summary: []},
            {type: 'output_text', text: 'Hi!'}
        ]
    });

    assert.deepEqual(result.messages, [
        {role: 'user', content: 'Hello'},
        {role: 'assistant', content: 'Hi!'}
    ]);
});

// === responsesResponseToChat content consistency tests ===

test('responsesResponseToChat sets content to empty string when tool_calls exist but no text', () => {
    // DeepSeek returns tool_calls with empty content, which should be "" not null
    const result = responsesResponseToChat({
        id: 'resp_1',
        output: [
            {type: 'reasoning', summary: [{type: 'summary_text', text: 'thinking...'}]},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'}
        ]
    });

    assert.equal(result.choices[0].message.content, '');
    assert.ok(result.choices[0].message.tool_calls);
    assert.equal(result.choices[0].message.reasoning_content, 'thinking...');
});

test('responsesResponseToChat sets content to null when no tool_calls and no text', () => {
    const result = responsesResponseToChat({
        id: 'resp_1',
        output: [
            {type: 'reasoning', summary: [{type: 'summary_text', text: 'thinking...'}]}
        ]
    });

    assert.equal(result.choices[0].message.content, null);
    assert.equal(result.choices[0].message.tool_calls, undefined);
    assert.equal(result.choices[0].message.reasoning_content, 'thinking...');
});

test('responsesResponseToChat preserves text content alongside tool_calls', () => {
    const result = responsesResponseToChat({
        id: 'resp_1',
        output: [
            {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Let me check.'}]},
            {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'}
        ]
    });

    assert.equal(result.choices[0].message.content, 'Let me check.');
    assert.ok(result.choices[0].message.tool_calls);
});

// === Conversation state merge tests ===

test('getDuplicatePrefixLength handles system message offset (base has system, visible does not)', async () => {
    // Simulate: base has [system, user, assistant], visible has [user, assistant, tool]
    // The system message is injected by relay's behavior rules but not in Codex's request
    const {RelayConversationStore} = await import('../src/services/session/conversation-state.js');
    const store = new RelayConversationStore({ttlMs: 60000, cleanupIntervalMs: 0});

    // Save first request's state (with system message from behavior rules)
    store.saveChatRequest({
        tenantId: 'test',
        conversationKey: 'conv1',
        request: {
            model: 'deepseek-chat',
            messages: [
                {role: 'system', content: 'You are a helpful assistant.'},
                {role: 'user', content: 'What is the weather?'},
                {role: 'assistant', reasoning_content: 'I need to call weather.', content: 'Let me check.', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'get_weather', arguments: '{}'}}]}
            ]
        }
    });

    // Second request: Codex sends full history (without system message) + tool result
    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId: 'test',
        conversationKey: 'conv1',
        request: {
            model: 'deepseek-chat',
            input: [
                {type: 'input_text', text: 'What is the weather?'},
                {type: 'reasoning', summary: [{type: 'summary_text', text: 'I need to call weather.'}]},
                {type: 'output_text', text: 'Let me check.'},
                {type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}'},
                {type: 'function_call_output', call_id: 'call_1', output: 'Sunny, 72°F'}
            ]
        }
    });

    // Should NOT duplicate user/assistant messages
    const messages = hydrated.chatRequest.messages;
    const userMsgCount = messages.filter(m => m.role === 'user').length;
    const assistantMsgCount = messages.filter(m => m.role === 'assistant').length;

    assert.equal(userMsgCount, 1, 'should have exactly 1 user message, not duplicated');
    assert.equal(assistantMsgCount, 1, 'should have exactly 1 assistant message, not duplicated');

    // The tool message should be present
    const toolMessages = messages.filter(m => m.role === 'tool');
    assert.equal(toolMessages.length, 1);
    assert.equal(toolMessages[0].tool_call_id, 'call_1');

    store.dispose();
});

test('hydration deduplication with system offset and matching content', async () => {
    const {RelayConversationStore} = await import('../src/services/session/conversation-state.js');
    const store = new RelayConversationStore({ttlMs: 60000, cleanupIntervalMs: 0});

    // Save state with system message
    store.saveChatRequest({
        tenantId: 'test',
        conversationKey: 'conv2',
        request: {
            model: 'deepseek-chat',
            messages: [
                {role: 'system', content: 'You are a helpful assistant.'},
                {role: 'user', content: 'Hello'},
                {role: 'assistant', content: 'Hi there!'}
            ]
        }
    });

    // Visible: no system message, same user + assistant, plus new user message
    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId: 'test',
        conversationKey: 'conv2',
        request: {
            model: 'deepseek-chat',
            input: [
                {type: 'input_text', text: 'Hello'},
                {type: 'output_text', text: 'Hi there!'},
                {type: 'input_text', text: 'How are you?'}
            ]
        }
    });

    const messages = hydrated.chatRequest.messages;

    // Should be: [system, user("Hello"), assistant("Hi there!"), user("How are you?")]
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'Hello');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].content, 'Hi there!');
    assert.equal(messages[3].role, 'user');
    assert.equal(messages[3].content, 'How are you?');

    store.dispose();
});
