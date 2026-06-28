import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RelayConversationStore} from '../src/services/session/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../src/services/session/responses-continuation.js';

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

    const input = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        ...Array.from({length: 1200}, (_, i) => ({role: 'user', content: `message ${i}`}))
    ];
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
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload sends only new input after previous response history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    // The relay handlers save Claude Code's full-history messages before preparing
    // the Responses continuation. The previous response coverage must survive that save.
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'},
                {role: 'user', content: 'second question'}
            ]
        }
    });

    const fullHistoryInput = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.match(
        logs.join('\n'),
        /Responses continuation: upstream input items=1 source_input_items=3 .*previous_response_id=resp_1 autoLink=true/
    );
});

test('prepareResponsesContinuationPayload sends delta directly for long matched history', () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 1200,
        maxCanonicalTurns: 1200
    });
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];
    const previousMessages = Array.from({length: 949}, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `previous message ${i}`
    }));

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: previousMessages
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_near_limit',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'previous answer'}]
            }]
        }
    });

    const fullHistoryInput = [
        ...previousMessages.map((message) => ({
            role: message.role,
            content: [{type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content}]
        })),
        {role: 'assistant', content: [{type: 'output_text', text: 'previous answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'new question'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_near_limit');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'new question'}]}
    ]);
    assert.match(logs.join('\n'), /delta input items 951->1/);
    assert.match(logs.join('\n'), /previous_response_id=resp_near_limit autoLink=true/);
});

test('prepareResponsesContinuationPayload ignores changed leading system reminder for delta coverage', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: '<system-reminder> old context'},
                {role: 'user', content: 'first question'}
            ]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {
                    role: 'user',
                    content: [
                        {type: 'input_text', text: '<system-reminder> refreshed context'},
                        {type: 'input_text', text: 'additional transient reminder'}
                    ]
                },
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload treats split interrupted-user marker as covered history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'},
                {role: 'user', content: '[Request interrupted by user] 请继续'}
            ]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_interrupted',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'continued answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {
                    role: 'user',
                    content: [
                        {type: 'input_text', text: '[Request interrupted by user]'},
                        {type: 'input_text', text: '请继续'}
                    ]
                },
                {role: 'assistant', content: [{type: 'output_text', text: 'continued answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'new question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_interrupted');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'new question'}]}
    ]);
    assert.match(logs.join('\n'), /delta input items 5->1/);
});

test('prepareResponsesContinuationPayload keeps tool-result delta for native Responses continuation', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'read relay adapter'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_tool_call',
            model: 'client-model',
            output: [{
                type: 'function_call',
                call_id: 'call_read',
                name: 'Read',
                arguments: '{"file_path":"src/services/relay/protocol-adapter.js"}'
            }]
        }
    });

    const fullHistoryInput = [
        {role: 'user', content: [{type: 'input_text', text: 'read relay adapter'}]},
        {
            type: 'function_call',
            call_id: 'call_read',
            name: 'Read',
            arguments: '{"file_path":"src/services/relay/protocol-adapter.js"}'
        },
        {
            type: 'function_call_output',
            call_id: 'call_read',
            output: 'src/services/relay/protocol-adapter.js:30: limitResponsesInputItems'
        },
        {
            role: 'assistant',
            content: [{
                type: 'output_text',
                text: "The TodoWrite tool hasn't been used recently."
            }]
        }
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_tool_call');
    assert.deepEqual(result.request.input, fullHistoryInput.slice(2));
    assert.match(logs.join('\n'), /delta input items 4->2/);
    assert.match(
        logs.join('\n'),
        /Responses continuation: upstream input items=2 source_input_items=4 .*previous_response_id=resp_tool_call autoLink=true/
    );
});

test('prepareResponsesContinuationPayload disables websocket auto-link when stored input is not a prefix', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [{role: 'user', content: [{type: 'input_text', text: 'unrelated fresh history'}]}]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.autoLink, false);
    assert.equal('previous_response_id' in result.request, false);
    assert.match(logs.join('\n'), /delta input mismatch; websocket auto-link disabled/);
    assert.match(logs.join('\n'), /upstream input items=1/);
});

test('prepareResponsesContinuationPayload tolerates clients omitting already-covered assistant output', () => {
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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload does not delta when covered assistant output diverges', () => {
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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'rewritten first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal('previous_response_id' in result.request, false);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.autoLink, false);
});

test('prepareResponsesContinuationPayload selects an older matching response snapshot for branched history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'branch A question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_branch_a',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'branch A answer'}]
            }]
        }
    });

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'branch B question'}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_branch_b',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'branch B answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'branch A question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'branch A answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'follow branch A'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_branch_a');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'follow branch A'}]}
    ]);
    assert.equal(result.deltaApplied, true);
});

test('prepareResponsesContinuationPayload does not send an empty delta upstream', () => {
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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, false);
    assert.equal(result.emptyDelta, true);
    assert.equal(result.autoLink, false);
    assert.equal('previous_response_id' in result.request, false);
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]}
    ]);
});

test('prepareResponsesContinuationPayload treats latest full coverage as empty even when older snapshots match', () => {
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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'},
                {role: 'user', content: 'second question'}
            ]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_2',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'second answer'}]
            }]
        }
    });

    const exactLatestInput = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'second answer'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: exactLatestInput
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, false);
    assert.equal(result.emptyDelta, true);
    assert.equal(result.deltaPreviousResponseId, 'resp_2');
    assert.equal('previous_response_id' in result.request, false);
    assert.deepEqual(result.request.input, exactLatestInput);
});

test('prepareResponsesContinuationPayload does not skip previous user turns when matching snapshots', () => {
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
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'first answer'}]
            }]
        }
    });

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [
                {role: 'user', content: 'first question'},
                {role: 'assistant', content: 'first answer'},
                {role: 'user', content: 'second question'}
            ]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_2',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'second answer'}]
            }]
        }
    });

    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'branch after first'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'branch after first'}]}
    ]);
});

test('prepareResponsesContinuationPayload writes mismatch diagnostics when enabled', () => {
    const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-continuation-diag-'));
    const diagFile = path.join(diagDir, 'diagnostics.jsonl');
    const env = setDiagnosticEnv({enabled: '1', file: diagFile});
    try {
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
                model: 'client-model',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'first answer'}]
                }]
            }
        });

        const result = prepareResponsesContinuationPayload({
            conversationStore: store,
            tenantId,
            conversationKey,
            request: {
                model: 'glm-5.2',
                input: [{role: 'user', content: [{type: 'input_text', text: 'unrelated fresh history'}]}]
            },
            requestType: 'AnthropicViaResponsesWebSocket',
            logger: {info() {}}
        });

        assert.equal(result.deltaApplied, false);
        assert.equal(fs.existsSync(diagFile), true);
        const records = fs.readFileSync(diagFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(records.length, 1);
        assert.equal(records[0].decision, 'mismatch');
        assert.equal(records[0].conversationKey, conversationKey);
        assert.equal(records[0].requestType, 'AnthropicViaResponsesWebSocket');
        assert.equal(records[0].currentInput.itemCount, 1);
        assert.equal(records[0].candidates[0].responseId, 'resp_1');
        assert.equal('fullInput' in records[0].currentInput, false);
        assert.equal('fullInput' in records[0].candidates[0], false);
    } finally {
        restoreDiagnosticEnv(env);
        fs.rmSync(diagDir, {recursive: true, force: true});
    }
});

test('prepareResponsesContinuationPayload does not write diagnostics by default', () => {
    const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-continuation-diag-'));
    const diagFile = path.join(diagDir, 'diagnostics.jsonl');
    const env = setDiagnosticEnv({enabled: undefined, file: diagFile});
    try {
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
                model: 'client-model',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'first answer'}]
                }]
            }
        });

        prepareResponsesContinuationPayload({
            conversationStore: store,
            tenantId,
            conversationKey,
            request: {
                model: 'glm-5.2',
                input: [{role: 'user', content: [{type: 'input_text', text: 'unrelated fresh history'}]}]
            },
            requestType: 'AnthropicViaResponsesWebSocket',
            logger: {info() {}}
        });

        assert.equal(fs.existsSync(diagFile), false);
    } finally {
        restoreDiagnosticEnv(env);
        fs.rmSync(diagDir, {recursive: true, force: true});
    }
});

function setDiagnosticEnv({enabled, file, full}) {
    const previous = {
        enabled: process.env.RELAY_RESPONSES_CONTINUATION_DIAG,
        file: process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE,
        full: process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL
    };
    if (enabled === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG = enabled;
    if (file === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE = file;
    if (full === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL = full;
    return previous;
}

function restoreDiagnosticEnv(previous) {
    if (previous.enabled === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG = previous.enabled;
    if (previous.file === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE = previous.file;
    if (previous.full === undefined) delete process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL;
    else process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL = previous.full;
}
