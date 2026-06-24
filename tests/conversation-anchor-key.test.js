import test from 'node:test';
import assert from 'node:assert/strict';
import {buildConversationAnchorKey} from '../src/protocol-engine/core/shared.js';

const basePayload = {
    model: 'glm-5.1',
    tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}],
    messages: [
        {role: 'system', content: 'stable system prompt'},
        {role: 'user', content: 'first question'},
        {role: 'assistant', content: 'first answer'}
    ]
};

test('conversation anchor key stays stable when later messages are appended', () => {
    const first = buildConversationAnchorKey(basePayload, {tenantId: 'tenant_1'});
    const next = buildConversationAnchorKey({
        ...basePayload,
        messages: [
            ...basePayload.messages,
            {role: 'user', content: 'follow up'},
            {role: 'assistant', content: 'follow up answer'}
        ]
    }, {tenantId: 'tenant_1'});

    assert.equal(first, next);
    assert.match(first, /^conv_[a-f0-9]{24}$/);
});

test('conversation anchor key changes for different first user message', () => {
    const first = buildConversationAnchorKey(basePayload, {tenantId: 'tenant_1'});
    const other = buildConversationAnchorKey({
        ...basePayload,
        messages: [
            basePayload.messages[0],
            {role: 'user', content: 'different first question'},
            basePayload.messages[2]
        ]
    }, {tenantId: 'tenant_1'});

    assert.notEqual(first, other);
});

test('conversation anchor key includes tenant dimension', () => {
    const tenantA = buildConversationAnchorKey(basePayload, {tenantId: 'tenant_1'});
    const tenantB = buildConversationAnchorKey(basePayload, {tenantId: 'tenant_2'});

    assert.notEqual(tenantA, tenantB);
});

test('conversation anchor key uses embedded session-id even outside the first user prefix', () => {
    const longSharedPrefix = 'same prefix '.repeat(40);
    const keyA = buildConversationAnchorKey({
        model: 'glm-5.1',
        messages: [
            {role: 'user', content: `${longSharedPrefix}<session-id>session-a</session-id>\nContinue`}
        ]
    }, {tenantId: 'tenant_1'});
    const keyB = buildConversationAnchorKey({
        model: 'glm-5.1',
        messages: [
            {role: 'user', content: `${longSharedPrefix}<session-id>session-b</session-id>\nContinue`}
        ]
    }, {tenantId: 'tenant_1'});

    assert.notEqual(keyA, keyB);
});

test('conversation anchor key uses system sessionId before weak first-user fallback', () => {
    const payloadA = {
        model: 'glm-5.2',
        messages: [
            {role: 'system', content: 'stable prompt\nsessionId: session-a'},
            {role: 'user', content: 'Continue'}
        ]
    };
    const payloadB = {
        model: 'glm-5.2',
        messages: [
            {role: 'system', content: 'stable prompt\nsessionId: session-b'},
            {role: 'user', content: 'Continue'}
        ]
    };

    const keyA = buildConversationAnchorKey(payloadA, {tenantId: 'tenant_1'});
    const keyB = buildConversationAnchorKey(payloadB, {tenantId: 'tenant_1'});

    assert.notEqual(keyA, keyB);
});

test('conversation anchor key can include client connection id when no stable session id exists', () => {
    const payload = {
        model: 'glm-5.1',
        messages: [{role: 'user', content: 'Continue'}]
    };

    const keyA = buildConversationAnchorKey(payload, {tenantId: 'tenant_1', clientConnectionId: 'ws-a'});
    const keyB = buildConversationAnchorKey(payload, {tenantId: 'tenant_1', clientConnectionId: 'ws-b'});

    assert.notEqual(keyA, keyB);
});

// ---- 新增：只基于第一条 user 消息 + tenantId，不随 system/tools 变化 ----

test('anchor key ignores system prompt changes — only first user message matters', () => {
    const keyA = buildConversationAnchorKey(basePayload, {tenantId: 't1'});
    const keyB = buildConversationAnchorKey({
        ...basePayload,
        messages: [
            {role: 'system', content: 'completely different system prompt'},
            ...basePayload.messages.slice(1)
        ]
    }, {tenantId: 't1'});

    assert.equal(keyA, keyB, 'system prompt should not affect anchor key');
});

test('anchor key ignores tools changes — only first user message matters', () => {
    const keyA = buildConversationAnchorKey(basePayload, {tenantId: 't1'});
    const keyB = buildConversationAnchorKey({
        ...basePayload,
        tools: [
            {type: 'function', function: {name: 'write_file', parameters: {type: 'object'}}},
            {type: 'function', function: {name: 'list_dir', parameters: {type: 'object'}}}
        ]
    }, {tenantId: 't1'});

    assert.equal(keyA, keyB, 'tools should not affect anchor key');
});

test('anchor key is stable even when tools are removed entirely', () => {
    const keyWithTools = buildConversationAnchorKey(basePayload, {tenantId: 't1'});
    const keyNoTools = buildConversationAnchorKey({
        ...basePayload,
        tools: undefined
    }, {tenantId: 't1'});

    assert.equal(keyWithTools, keyNoTools, 'removing tools should not change anchor key');
});

test('anchor key only depends on first user message + tenantId', () => {
    // 两个完全不同的 payload，只要第一条 user 消息和 tenantId 相同，key 就相同
    const payloadA = {
        model: 'model-a',
        tools: [{type: 'function', function: {name: 'tool_a'}}],
        messages: [
            {role: 'system', content: 'system A'},
            {role: 'user', content: 'hello world'},
            {role: 'assistant', content: 'response A'}
        ]
    };
    const payloadB = {
        model: 'model-b',
        tools: [{type: 'function', function: {name: 'tool_b'}}],
        messages: [
            {role: 'system', content: 'system B'},
            {role: 'user', content: 'hello world'},
            {role: 'assistant', content: 'response B'}
        ]
    };

    const keyA = buildConversationAnchorKey(payloadA, {tenantId: 't1'});
    const keyB = buildConversationAnchorKey(payloadB, {tenantId: 't1'});

    assert.equal(keyA, keyB, 'same first user msg + same tenantId should produce same key');
});
