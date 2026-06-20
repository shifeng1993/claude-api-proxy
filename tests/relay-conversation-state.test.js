import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RelayConversationStore,
    RelayStateMissingError
} from '../src/services/relay/conversation-state.js';

test('default TTL keeps stable single-instance conversations for at least one day', () => {
    const store = new RelayConversationStore({cleanupIntervalMs: 0});

    assert.equal(store.ttlMs >= 24 * 60 * 60 * 1000, true);
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
