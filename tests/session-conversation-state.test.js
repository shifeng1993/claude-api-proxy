import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RelayConversationStore,
    RelayStateMissingError
} from '../src/services/session/conversation-state.js';
import {
    canonicalFromAnthropicResponse,
    canonicalFromAnthropicRequest,
    canonicalFromAnthropicStreamChatResponse,
    renderCanonicalToChat
} from '../src/protocol-engine/core/canonical/session.js';
import {anthropicResponseToChat} from '../src/protocol-engine/core/http-converters.js';

test('default TTL keeps stable single-instance conversations for at least one day', () => {
    const store = new RelayConversationStore({cleanupIntervalMs: 0});

    assert.equal(store.ttlMs >= 24 * 60 * 60 * 1000, true);
});

test('default conversation state limits bound cached chat and canonical history', () => {
    const previousMaxChatMessages = process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES;
    const previousMaxCanonicalTurns = process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS;
    delete process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES;
    delete process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS;

    try {
        const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
        const messages = Array.from({length: 205}, (_unused, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `message ${index + 1}`
        }));

        assert.equal(store.maxStoredChatMessages, 200);
        assert.equal(store.maxCanonicalTurns, 200);

        store.saveChatRequest({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {
                model: 'client-model',
                messages
            }
        });

        const state = store.conversations.get('tenant-a:conv-a');
        assert.equal(state.chatRequest.messages.length, 200);
        assert.equal(state.chatRequestTruncated, true);
        assert.equal(state.chatRequestMessageCount, 205);
        assert.equal(state.canonicalSession.turns.length, 200);
        assert.equal(state.canonicalSessionTruncated, true);
        assert.equal(state.canonicalTurnCount, 205);
    } finally {
        if (previousMaxChatMessages === undefined) delete process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES;
        else process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES = previousMaxChatMessages;

        if (previousMaxCanonicalTurns === undefined) delete process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS;
        else process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS = previousMaxCanonicalTurns;
    }
});

test('hydrateResponsesForFullHistory appends Responses input to stored chat history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'system', content: 'You are concise.'},
                {role: 'user', content: 'first question'}
            ],
            tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
            tool_choice: 'auto'
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey: undefined,
        request: {
            model: 'client-model',
            previous_response_id: 'resp_1',
            input: [{role: 'user', content: [{type: 'input_text', text: 'second question'}]}],
            stream: false
        }
    });

    assert.equal(hydrated.conversationKey, conversationKey);
    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'system', content: 'You are concise.'},
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
    assert.deepEqual(hydrated.chatRequest.tools, [
        {type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}
    ]);
    assert.equal(hydrated.chatRequest.tool_choice, 'auto');
});

test('hydrateResponsesForFullHistory does not duplicate a visible full-history prefix', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'}
            ]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        }
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
});

test('prepareResponsesPassthrough does not duplicate a visible full-history prefix', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'}
            ]
        }
    });

    store.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {model: 'client-model', input: []}
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
});

test('prepareResponsesPassthrough appends visible input to an existing conversation key', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'}
            ]
        }
    });

    store.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [{role: 'user', content: [{type: 'input_text', text: 'second question'}]}]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {model: 'client-model', input: []}
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
});

test('prepareResponsesPassthrough exposes the latest stored response id for continuation truncation', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'first question'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_2',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'second answer'}]}]
        }
    });

    const prepared = store.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request: {model: 'client-model', input: [{role: 'user', content: 'third question'}]}
    });

    assert.equal(prepared.lastResponseId, 'resp_2');
});

test('recordResponsesResponse keeps Responses item ids in canonical session', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_resp_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].responsesItemId, 'fc_1');
    assert.equal(state.canonicalSession.toolMappings[0].responsesCallId, 'call_resp_1');

    const chat = renderCanonicalToChat(state.canonicalSession);
    assert.equal(chat.messages.at(-1).tool_calls[0].id, 'call_resp_1');
});

test('recordResponsesResponse preserves upstream Anthropic tool_use_id mapping', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const anthropicResponse = {
        model: 'claude-test',
        content: [{
            type: 'tool_use',
            id: 'toolu_resp_1',
            name: 'read_file',
            input: {path: 'README.md'}
        }]
    };

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_resp_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }]
        },
        sourceCanonicalSession: canonicalFromAnthropicResponse(anthropicResponse, {tenantId, conversationKey})
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].responsesItemId, 'fc_1');
    assert.equal(state.canonicalSession.toolMappings[0].responsesCallId, 'call_resp_1');
    assert.equal(state.canonicalSession.toolMappings[0].anthropicToolUseId, 'toolu_resp_1');
});

test('recordResponsesResponse appends file output through canonical chat rendering', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-output-file';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'gpt-test', messages: [{role: 'user', content: 'make report'}]}
    });
    const state = store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_file',
            model: 'gpt-test',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [
                    {type: 'output_text', text: 'report ready'},
                    {type: 'file', file: {filename: 'report.txt', file_data: 'base64-report'}}
                ]
            }]
        }
    });

    assert.deepEqual(state.chatRequest.messages[1].content, [
        {type: 'text', text: 'report ready'},
        {type: 'file', file: 'base64-report'}
    ]);
});

test('hydrateResponsesForFullHistory preserves Responses input item ids in canonical session', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [{
                type: 'function_call',
                id: 'fc_input_1',
                call_id: 'call_input_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].responsesItemId, 'fc_input_1');
    assert.equal(state.canonicalSession.toolMappings[0].responsesCallId, 'call_input_1');
});

test('hydrateResponsesForFullHistory converts Responses file data through canonical chat rendering', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-file';

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'gpt-test',
            input: [{
                role: 'user',
                content: [
                    {type: 'input_text', text: 'inspect this file'},
                    {type: 'input_file', filename: 'report.txt', file_data: 'base64-report'}
                ]
            }]
        }
    });

    assert.deepEqual(hydrated.chatRequest.messages[0].content, [
        {type: 'text', text: 'inspect this file'},
        {type: 'file', file: 'base64-report'}
    ]);
});

test('prepareResponsesPassthrough preserves canonical Responses item ids across history save', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_resp_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }]
        }
    });

    store.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            previous_response_id: 'resp_1',
            input: [{role: 'user', content: [{type: 'input_text', text: 'now summarize'}]}]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].responsesItemId, 'fc_1');
    assert.equal(state.canonicalSession.toolMappings[0].responsesCallId, 'call_resp_1');
});

test('hydrateResponsesForFullHistory can recover base history from canonical session', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'first question'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]}]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    state.chatRequest = {model: 'client-model', messages: []};

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            previous_response_id: 'resp_1',
            input: [{role: 'user', content: [{type: 'input_text', text: 'second question'}]}]
        }
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
});

test('maxStoredChatMessages trims cached chatRequest while canonical recovers full history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0, maxStoredChatMessages: 2});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'system', content: 'Be concise.'},
                {role: 'user', content: 'first'},
                {role: 'assistant', content: 'one'},
                {role: 'user', content: 'second'}
            ]
        }
    });

    const stored = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(stored.chatRequest.messages.length, 2);
    assert.equal(stored.chatRequestTruncated, true);
    assert.equal(stored.chatRequestMessageCount, 4);

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [{role: 'user', content: [{type: 'input_text', text: 'third'}]}]
        }
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'system', content: 'Be concise.'},
        {role: 'user', content: 'first'},
        {role: 'assistant', content: 'one'},
        {role: 'user', content: 'second'},
        {role: 'user', content: 'third'}
    ]);

    const updated = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(updated.chatRequest.messages.length, 2);
    assert.equal(updated.chatRequestMessageCount, 5);
});

test('RelayConversationStore reads chat cache trim limit from env', () => {
    const previous = process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES;
    process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES = '1';
    try {
        const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
        store.saveChatRequest({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {
                model: 'client-model',
                messages: [
                    {role: 'user', content: 'first'},
                    {role: 'assistant', content: 'one'}
                ]
            }
        });

        const state = store.conversations.get('tenant-a:conv-a');
        assert.equal(state.chatRequest.messages.length, 1);
        assert.equal(store.maxStoredChatMessages, 1);
    } finally {
        if (previous === undefined) delete process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES;
        else process.env.RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES = previous;
    }
});

test('maxCanonicalTurns trims canonical session while avoiding orphan tool results', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0, maxCanonicalTurns: 4});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'system', content: 'Be concise.'},
                {role: 'user', content: 'first'},
                {role: 'assistant', content: 'one'},
                {role: 'user', content: 'second'},
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                    }]
                },
                {role: 'tool', tool_call_id: 'call_1', content: 'README text'},
                {role: 'user', content: 'third'}
            ]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.turns.length, 4);
    assert.equal(state.canonicalSessionTruncated, true);
    assert.equal(state.canonicalTurnCount, 7);
    assert.deepEqual(state.canonicalSession.turns.map((turn) => turn.role), ['system', 'assistant', 'tool', 'user']);
    assert.equal(state.canonicalSession.toolMappings.length, 1);

    const rendered = renderCanonicalToChat(state.canonicalSession);
    assert.equal(rendered.messages[1].tool_calls[0].id, 'call_1');
    assert.equal(rendered.messages[2].tool_call_id, 'call_1');
});

test('RelayConversationStore reads canonical turn trim limit from env', () => {
    const previous = process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS;
    process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS = '2';
    try {
        const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
        assert.equal(store.maxCanonicalTurns, 2);
    } finally {
        if (previous === undefined) delete process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS;
        else process.env.RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS = previous;
    }
});

test('saveChatRequest accepts source canonical session to preserve Anthropic tool ids', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const anthropicRequest = {
        model: 'claude-test',
        messages: [{
            role: 'assistant',
            content: [{
                type: 'tool_use',
                id: 'toolu_1',
                name: 'read_file',
                input: {path: 'README.md'}
            }]
        }]
    };

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'claude-test',
            messages: [{
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'toolu_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            }]
        },
        canonicalSession: canonicalFromAnthropicRequest(anthropicRequest, {tenantId, conversationKey})
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].anthropicToolUseId, 'toolu_1');
    assert.equal(state.canonicalSession.toolMappings[0].openAIChatToolCallId, 'toolu_1');
});

test('recordChatResponse keeps Chat tool_call_id in canonical session', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordChatResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'chatcmpl_1',
            model: 'client-model',
            choices: [{
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_chat_1',
                        type: 'function',
                        function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        }
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].openAIChatToolCallId, 'call_chat_1');
});

test('recordChatResponse can preserve Anthropic stream tool_use_id source mapping', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const chatResponse = {
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
    };

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'claude-test', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordChatResponse({
        tenantId,
        conversationKey,
        response: chatResponse,
        sourceCanonicalSession: canonicalFromAnthropicStreamChatResponse(chatResponse, {tenantId, conversationKey})
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].openAIChatToolCallId, 'toolu_stream_1');
    assert.equal(state.canonicalSession.toolMappings[0].anthropicToolUseId, 'toolu_stream_1');
});

test('recordAnthropicResponse keeps upstream tool_use_id in canonical session', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const anthropicResponse = {
        id: 'msg_1',
        model: 'claude-test',
        stop_reason: 'tool_use',
        content: [{
            type: 'tool_use',
            id: 'toolu_resp_1',
            name: 'read_file',
            input: {path: 'README.md'}
        }],
        usage: {input_tokens: 3, output_tokens: 4}
    };

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'claude-test', messages: [{role: 'user', content: 'read README'}]}
    });
    store.recordAnthropicResponse({
        tenantId,
        conversationKey,
        response: anthropicResponse,
        chatResponse: anthropicResponseToChat(anthropicResponse, 'claude-test')
    });

    const state = store.conversations.get(`${tenantId}:${conversationKey}`);
    assert.equal(state.canonicalSession.toolMappings[0].anthropicToolUseId, 'toolu_resp_1');
    assert.equal(state.canonicalSession.toolMappings[0].openAIChatToolCallId, null);

    const chat = renderCanonicalToChat(state.canonicalSession);
    assert.equal(chat.messages.at(-1).tool_calls[0].id, 'toolu_resp_1');
    assert.equal(state.chatRequest.messages.at(-1).tool_calls[0].id, 'toolu_resp_1');
});

test('hydrateResponsesForFullHistory throws state_missing when previous response is unknown', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});

    assert.throws(
        () => store.hydrateResponsesForFullHistory({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {
                model: 'client-model',
                previous_response_id: 'resp_missing',
                input: 'continue'
            }
        }),
        RelayStateMissingError
    );
});

test('prepareResponsesPassthrough leaves unknown previous_response_id untouched', () => {
    const store = new RelayConversationStore({ttlMs: 60_000});
    const result = store.prepareResponsesPassthrough({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'client-model',
            previous_response_id: 'resp_remote',
            input: 'continue'
        }
    });

    assert.equal(result.request.previous_response_id, 'resp_remote');
    assert.equal(result.conversationKey, 'conv-a');
});

test('prepareResponsesPassthrough preserves visible input for later protocol switches', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    const prepared = store.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            input: [{role: 'user', content: [{type: 'input_text', text: 'first question'}]}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey: prepared.conversationKey,
        response: {
            id: 'resp_1',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const hydrated = store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            previous_response_id: 'resp_1',
            input: [{role: 'user', content: [{type: 'input_text', text: 'second question'}]}]
        }
    });

    assert.deepEqual(hydrated.chatRequest.messages, [
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'},
        {role: 'user', content: 'second question'}
    ]);
});

test('expired conversation removes every response id index for that conversation', () => {
    let now = 0;
    const store = new RelayConversationStore({ttlMs: 1000, now: () => now, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'first'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {id: 'resp_1', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'one'}]}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {id: 'resp_2', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'two'}]}]}
    });

    assert.equal(store.responseIndex.size, 2);

    now = 1001;
    assert.throws(
        () => store.hydrateResponsesForFullHistory({
            tenantId,
            conversationKey,
            request: {model: 'client-model', previous_response_id: 'resp_1', input: 'continue'}
        }),
        RelayStateMissingError
    );

    assert.equal(store.conversations.size, 0);
    assert.equal(store.responseIndex.size, 0);
});

test('cleanupExpired prunes idle conversations without a follow-up request', () => {
    let now = 0;
    const store = new RelayConversationStore({ttlMs: 1000, now: () => now, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    assert.equal(typeof store.cleanupExpired, 'function');
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'client-model', messages: [{role: 'user', content: 'first'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {id: 'resp_1', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'one'}]}]}
    });

    now = 1001;
    assert.equal(store.cleanupExpired(), 1);
    assert.equal(store.conversations.size, 0);
    assert.equal(store.responseIndex.size, 0);
});
