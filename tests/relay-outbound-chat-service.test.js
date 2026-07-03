import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cloneRelayJson,
    prepareRelayOutboundChatRequest
} from '../src/services/relay/protocols/chat/outbound.js';

test('cloneRelayJson returns a deep clone without sharing nested objects', () => {
    const source = {messages: [{role: 'user', content: [{type: 'text', text: 'hi'}]}]};
    const cloned = cloneRelayJson(source);

    assert.deepEqual(cloned, source);
    assert.notEqual(cloned, source);
    assert.notEqual(cloned.messages, source.messages);
    assert.notEqual(cloned.messages[0].content, source.messages[0].content);
    assert.equal(cloneRelayJson(null), null);
});

test('prepareRelayOutboundChatRequest clones and shapes only the outbound chat request', () => {
    const calls = [];
    const source = {
        model: 'stored-model',
        stream: false,
        messages: [{role: 'user', content: 'hello'}]
    };

    const outbound = prepareRelayOutboundChatRequest(source, {
        model: 'upstream-model',
        stream: true,
        injectBehaviorRules: (messages, model) => {
            calls.push(['inject', model, messages.length]);
            return [...messages, {role: 'system', content: 'dynamic reminder'}];
        },
        stripDynamicReminders: (messages) => {
            calls.push(['strip', messages.length]);
            return messages.filter((message) => message.role !== 'system');
        },
        mergeConsecutiveAssistantMessages: (messages) => {
            calls.push(['merge', messages.length]);
            messages.push({role: 'assistant', content: 'merged'});
        }
    });

    assert.deepEqual(source, {
        model: 'stored-model',
        stream: false,
        messages: [{role: 'user', content: 'hello'}]
    });
    assert.deepEqual(outbound, {
        model: 'upstream-model',
        stream: true,
        messages: [
            {role: 'user', content: 'hello'},
            {role: 'assistant', content: 'merged'}
        ]
    });
    assert.deepEqual(calls, [
        ['inject', 'upstream-model', 1],
        ['strip', 2],
        ['merge', 1]
    ]);
});

test('prepareRelayOutboundChatRequest preserves stream when no override is supplied', () => {
    const outbound = prepareRelayOutboundChatRequest(
        {model: 'gpt-5', stream: false, messages: []},
        {
            injectBehaviorRules: (messages) => messages,
            stripDynamicReminders: (messages) => messages,
            mergeConsecutiveAssistantMessages: () => {}
        }
    );

    assert.equal(outbound.model, 'gpt-5');
    assert.equal(outbound.stream, false);
});

test('prepareRelayOutboundChatRequest strips Responses continuation controls before Chat upstream', () => {
    const outbound = prepareRelayOutboundChatRequest(
        {
            model: 'gpt-5',
            stream: true,
            previous_response_id: 'resp_123',
            store: false,
            messages: [{role: 'user', content: 'hello'}]
        },
        {
            injectBehaviorRules: (messages) => messages,
            stripDynamicReminders: (messages) => messages,
            mergeConsecutiveAssistantMessages: () => {}
        }
    );

    assert.equal('previous_response_id' in outbound, false);
    assert.equal('store' in outbound, false);
    assert.deepEqual(outbound.messages, [{role: 'user', content: 'hello'}]);
});
