import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayConversationStore} from '../src/services/relay/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../src/services/relay/responses-continuation.js';

test('prepareResponsesContinuationPayload limits converted full-history input using stored response id', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first question'}]
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

    const input = Array.from({length: 1200}, (_, i) => ({role: 'user', content: `message ${i}`}));
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.conversationKey, conversationKey);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.equal(result.request.input.length, 500);
    assert.equal(result.request.input[0].content, 'message 700');
    assert.equal(result.request.input.at(-1).content, 'message 1199');
});
