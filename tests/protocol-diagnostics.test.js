import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayConversationStore, relayConversationStore} from '../src/services/session/conversation-state.js';
import {routeRelayRequest} from '../src/routes/relay.js';
import {canonicalFromAnthropicRequest} from '../src/protocol-engine/core/canonical/session.js';
import {
    analyzeChatToolClosure,
    getRelayConversationDiagnostics,
    inspectResponsesStreamState
} from '../src/protocol-engine/core/diagnostics/index.js';

test('analyzeChatToolClosure reports missing and orphan tool results', () => {
    const messages = [
        {role: 'user', content: 'call tools'},
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {id: 'call_1', type: 'function', function: {name: 'read_file', arguments: '{}'}},
                {id: 'call_2', type: 'function', function: {name: 'list_dir', arguments: '{}'}}
            ]
        },
        {role: 'tool', tool_call_id: 'call_1', content: 'README'},
        {role: 'tool', tool_call_id: 'orphan', content: 'no matching call'}
    ];

    const result = analyzeChatToolClosure(messages);

    assert.deepEqual(result.missingToolResults, [
        {toolCallId: 'call_2', messageIndex: 1, name: 'list_dir'}
    ]);
    assert.deepEqual(result.orphanToolResults, [
        {toolCallId: 'orphan', messageIndex: 3}
    ]);
    assert.equal(result.toolCallCount, 2);
    assert.equal(result.toolResultCount, 2);
});

test('getRelayConversationDiagnostics summarizes stored sessions without cloning full payloads', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'gpt-test',
            messages: [
                {role: 'system', content: 'Be concise.'},
                {role: 'user', content: 'first'},
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {id: 'call_1', type: 'function', function: {name: 'read_file', arguments: '{"path":"README.md"}'}}
                    ]
                }
            ],
            tools: [{type: 'function', function: {name: 'read_file', parameters: {type: 'object'}}}]
        }
    });
    store.recordResponsesResponse({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        response: {
            id: 'resp_1',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'done'}]}]
        }
    });

    const diagnostics = getRelayConversationDiagnostics(store);

    assert.equal(diagnostics.totalConversations, 1);
    assert.equal(diagnostics.totalResponseIndexEntries, 1);
    assert.equal(diagnostics.sessions.length, 1);
    assert.match(diagnostics.sessions[0].conversationId, /^tenant-a:conv-a$/);
    assert.equal(diagnostics.sessions[0].messageCount, 4);
    assert.equal(diagnostics.sessions[0].toolCallCount, 1);
    assert.equal(diagnostics.sessions[0].toolResultCount, 0);
    assert.equal(diagnostics.sessions[0].missingToolResults.length, 1);
    assert.equal(typeof diagnostics.sessions[0].approxBytes, 'number');
    assert.equal('chatRequest' in diagnostics.sessions[0], false);
});

test('getRelayConversationDiagnostics reports canonical tool closure issues', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {model: 'claude-test', messages: []},
        canonicalSession: canonicalFromAnthropicRequest({
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
        }, {tenantId: 'tenant-a', conversationKey: 'conv-a'})
    });

    const diagnostics = getRelayConversationDiagnostics(store);

    assert.deepEqual(diagnostics.sessions[0].canonicalMissingToolResults, [{
        canonicalToolCallId: 'ctc_1',
        turnIndex: 0,
        blockIndex: 0,
        name: 'read_file',
        toolIds: {
            openAIChatToolCallId: null,
            responsesCallId: null,
            responsesItemId: null,
            anthropicToolUseId: 'toolu_1'
        }
    }]);
    assert.equal(diagnostics.toolIssues[0].type, 'missing_canonical_tool_result');
});

test('getRelayConversationDiagnostics reports truncated chat request caches', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0, maxStoredChatMessages: 1});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'gpt-test',
            messages: [
                {role: 'user', content: 'first'},
                {role: 'assistant', content: 'one'},
                {role: 'user', content: 'second'}
            ]
        }
    });

    const diagnostics = getRelayConversationDiagnostics(store);

    assert.equal(diagnostics.sessions[0].messageCount, 1);
    assert.equal(diagnostics.sessions[0].chatRequestTruncated, true);
    assert.equal(diagnostics.sessions[0].chatRequestMessageCount, 3);
    assert.equal(diagnostics.memoryHotspots[0].chatRequestTruncated, true);
});

test('getRelayConversationDiagnostics reports truncated canonical sessions', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0, maxCanonicalTurns: 2});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {
            model: 'gpt-test',
            messages: [
                {role: 'user', content: 'first'},
                {role: 'assistant', content: 'one'},
                {role: 'user', content: 'second'}
            ]
        }
    });

    const diagnostics = getRelayConversationDiagnostics(store);

    assert.equal(diagnostics.sessions[0].canonicalSessionTruncated, true);
    assert.equal(diagnostics.sessions[0].canonicalOriginalTurnCount, 3);
    assert.equal(diagnostics.sessions[0].canonicalTurnCount, 2);
    assert.equal(diagnostics.memoryHotspots[0].canonicalSessionTruncated, true);
    assert.equal(diagnostics.memoryHotspots[0].canonicalOriginalTurnCount, 3);
});

test('getRelayConversationDiagnostics ranks memory hotspots by chat and canonical bytes', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0, maxStoredChatMessages: 1});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'small',
        request: {
            model: 'gpt-test',
            messages: [{role: 'user', content: 'small'}]
        }
    });
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'large',
        request: {
            model: 'gpt-test',
            messages: [
                {role: 'user', content: 'small tail'},
                {role: 'assistant', content: 'x'.repeat(10_000)}
            ]
        }
    });

    const diagnostics = getRelayConversationDiagnostics(store);

    assert.equal(diagnostics.memoryHotspots[0].conversationId, 'tenant-a:large');
    assert.equal(typeof diagnostics.totalCanonicalApproxBytes, 'number');
    assert.equal(typeof diagnostics.totalCombinedApproxBytes, 'number');
});

test('getRelayConversationDiagnostics filters sessions by tenant', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    store.saveChatRequest({
        tenantId: 'tenant-a',
        conversationKey: 'conv-a',
        request: {model: 'gpt-test', messages: [{role: 'user', content: 'tenant a secret'}]}
    });
    store.saveChatRequest({
        tenantId: 'tenant-b',
        conversationKey: 'conv-b',
        request: {model: 'gpt-test', messages: [{role: 'user', content: 'tenant b secret'}]}
    });

    const diagnostics = getRelayConversationDiagnostics(store, {tenantId: 'tenant-a'});

    assert.equal(diagnostics.totalConversations, 1);
    assert.deepEqual(diagnostics.sessions.map((session) => session.conversationId), ['tenant-a:conv-a']);
});

test('routeRelayRequest exposes sanitized relay diagnostics', async () => {
    relayConversationStore.conversations.clear();
    relayConversationStore.responseIndex.clear();
    try {
        relayConversationStore.saveChatRequest({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {
                model: 'gpt-test',
                messages: [
                    {role: 'user', content: 'do not leak this prompt'},
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{id: 'call_1', type: 'function', function: {name: 'read_file', arguments: '{}'}}]
                    }
                ]
            }
        });
        relayConversationStore.saveChatRequest({
            tenantId: 'tenant-b',
            conversationKey: 'conv-b',
            request: {model: 'gpt-test', messages: [{role: 'user', content: 'other tenant prompt'}]}
        });

        const res = createMockResponse();
        await routeRelayRequest({
            method: 'GET',
            url: '/relay/v1/diagnostics',
            headers: {host: 'localhost'},
            tenantId: 'tenant-a'
        }, res);

        const payload = JSON.parse(res.body);
        assert.equal(res.statusCode, 200);
        assert.equal(payload.totalConversations, 1);
        assert.equal(payload.sessions[0].conversationId, 'tenant-a:conv-a');
        assert.equal(payload.sessions[0].missingToolResults.length, 1);
        assert.equal('chatRequest' in payload.sessions[0], false);
        assert.equal('messages' in payload.sessions[0], false);
        assert.equal(res.body.includes('do not leak this prompt'), false);
        assert.equal(res.body.includes('other tenant prompt'), false);
    } finally {
        relayConversationStore.conversations.clear();
        relayConversationStore.responseIndex.clear();
    }
});

test('routeRelayRequest rejects diagnostics without tenant identity', async () => {
    relayConversationStore.conversations.clear();
    relayConversationStore.responseIndex.clear();
    try {
        relayConversationStore.saveChatRequest({
            tenantId: 'tenant-a',
            conversationKey: 'conv-a',
            request: {model: 'gpt-test', messages: [{role: 'user', content: 'do not leak this prompt'}]}
        });

        const res = createMockResponse();
        await routeRelayRequest({
            method: 'GET',
            url: '/relay/v1/diagnostics',
            headers: {host: 'localhost'}
        }, res);

        assert.equal(res.statusCode, 401);
        assert.equal(res.body.includes('do not leak this prompt'), false);
    } finally {
        relayConversationStore.conversations.clear();
        relayConversationStore.responseIndex.clear();
    }
});

test('inspectResponsesStreamState reports unclosed buffers and partial tool arguments', () => {
    const state = {
        messageOpen: true,
        reasoningOpen: true,
        textBuffer: 'hello',
        reasoningText: 'thinking',
        toolCallItemIds: new Map([[0, 'fc_1']]),
        toolCallNames: new Map([[0, 'read_file']]),
        toolCallArgs: new Map([[0, '{"path":"README.md"']]),
        output: [{type: 'reasoning'}]
    };

    const diagnostics = inspectResponsesStreamState(state);

    assert.equal(diagnostics.unclosedMessage, true);
    assert.equal(diagnostics.unclosedReasoning, true);
    assert.equal(diagnostics.textBufferBytes, Buffer.byteLength('hello'));
    assert.equal(diagnostics.reasoningBufferBytes, Buffer.byteLength('thinking'));
    assert.deepEqual(diagnostics.partialToolArguments, [
        {index: 0, itemId: 'fc_1', name: 'read_file', bytes: Buffer.byteLength('{"path":"README.md"'), validJson: false}
    ]);
});

function createMockResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        headersSent: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        end(chunk = '') {
            this.body += chunk;
        }
    };
}
