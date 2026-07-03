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

test('prepareResponsesContinuationPayload matches when user message split across text parts differently between rounds', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    // 第一轮：客户端以合并字符串发送 user message，快照侧渲染为单个 input_text part
    // 文本 "first\n\nquestion" 对应本轮拆成两个 part 后用 \n\n 拼接的结果
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first\n\nquestion'}]
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

    // 本轮：同一 user message 被拆成多个 input_text part（Claude Code 注入动态上下文时的常见形态）
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [
                    {type: 'input_text', text: 'first'},
                    {type: 'input_text', text: 'question'}
                ]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
});

test('prepareResponsesContinuationPayload coalesces adjacent text parts around image parts', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    const imageUrl = 'https://example.com/image.png';
    // 快照侧：图片前后各一段合并文本（与本轮拆分后用 \n\n 拼接一致）
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: [
                {type: 'text', text: 'look\n\nat this'},
                {type: 'image_url', image_url: {url: imageUrl}},
                {type: 'text', text: 'describe\n\nit'}
            ]}]
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
                content: [{type: 'output_text', text: 'a picture'}]
            }]
        }
    });

    // 本轮：图片两侧的文本 part 被各自再拆分，验证不跨图片合并
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [
                    {type: 'input_text', text: 'look'},
                    {type: 'input_text', text: 'at this'},
                    {type: 'input_image', image_url: imageUrl},
                    {type: 'input_text', text: 'describe'},
                    {type: 'input_text', text: 'it'}
                ]},
                {role: 'assistant', content: [{type: 'output_text', text: 'a picture'}]},
                {role: 'user', content: [{type: 'input_text', text: 'next question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'next question'}]}
    ]);
});

test('prepareResponsesContinuationPayload matches when adjacent text parts carry differing surrounding whitespace', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    // 快照侧文本含 \n\n\n\n，对应本轮 part 末尾的 \n\n 加上合并分隔符 \n\n
    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'first\n\n\n\nquestion'}]
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

    // 本轮：第一个 part 以换行结尾，模拟动态注入产生的空白差异
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [
                    {type: 'input_text', text: 'first\n\n'},
                    {type: 'input_text', text: 'question'}
                ]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
});

test('prepareResponsesContinuationPayload ignores relay private fields when matching covered history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'Read this'}]
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
                    content: [{type: 'input_text', text: 'Read this'}],
                    x_relay_anthropic_content: [
                        {type: 'text', text: 'Read this', cache_control: {type: 'ephemeral'}}
                    ]
                },
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

test('prepareResponsesContinuationPayload deltas when covered reasoning carries relay thinking signature', () => {
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
            output: [
                {
                    type: 'reasoning',
                    id: 'rs_1',
                    summary: [{type: 'summary_text', text: 'reasoning about the question'}],
                    x_relay_anthropic_thinking: [{
                        type: 'thinking',
                        thinking: 'reasoning about the question',
                        signature: 'sig_abc'
                    }]
                },
                {
                    type: 'message',
                    id: 'msg_1',
                    status: 'completed',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'first answer'}]
                }
            ]
        }
    });

    // 客户端回传的完整历史，reasoning 项已被出口 stripRelayResponsesPrivateFields
    // 剥掉 x_relay_ 字段，只剩 summary（与快照侧不对称，曾导致 mismatch）。
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
                {type: 'reasoning', summary: [{type: 'summary_text', text: 'reasoning about the question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
});

test('prepareResponsesContinuationPayload does not ignore relay thinking when text diverges from summary', () => {
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
            output: [
                {
                    type: 'reasoning',
                    id: 'rs_1',
                    summary: [{type: 'summary_text', text: 'summary text'}],
                    x_relay_anthropic_thinking: [{
                        type: 'thinking',
                        thinking: 'different thinking content',
                        signature: 'sig_abc'
                    }]
                },
                {
                    type: 'message',
                    id: 'msg_1',
                    status: 'completed',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'first answer'}]
                }
            ]
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
                {type: 'reasoning', summary: [{type: 'summary_text', text: 'summary text'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    // Covered reasoning is represented by previous_response_id; only the new user item is sent.
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
});

test('prepareResponsesContinuationPayload preserves redacted thinking field when not expressible by summary', () => {
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
            output: [
                {
                    type: 'reasoning',
                    id: 'rs_1',
                    summary: [],
                    x_relay_anthropic_thinking: [{
                        type: 'redacted_thinking',
                        data: 'redacted_data'
                    }]
                },
                {
                    type: 'message',
                    id: 'msg_1',
                    status: 'completed',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'first answer'}]
                }
            ]
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
                {type: 'reasoning', summary: []},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    // Covered redacted thinking stays in the previous response state.
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
});

test('prepareResponsesContinuationPayload preserves semantic relay private fields when matching covered history', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {
            model: 'client-model',
            messages: [{role: 'user', content: 'Read this'}]
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

    const fullHistoryInput = [
        {
            role: 'user',
            content: [{type: 'input_text', text: 'Read this'}],
            x_relay_anthropic_content: [
                {type: 'text', text: 'Read this'},
                {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'PDFDATA'}}
            ]
        },
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: fullHistoryInput
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

test('prepareResponsesContinuationPayload sends full input when continuation is disabled', () => {
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

    const fullHistoryInput = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', previous_response_id: 'resp_1', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        disableContinuation: true,
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.request.previous_response_id, undefined);
    assert.deepEqual(result.request.input, fullHistoryInput);
    assert.equal(result.deltaAttempted, false);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.emptyDelta, false);
    assert.equal(result.autoLink, false);
    assert.match(
        logs.join('\n'),
        /Responses continuation: disabled; sending full input items=3 .*requestType=AnthropicViaResponsesWebSocket/
    );
});

test('prepareResponsesContinuationPayload preserves oversized input when continuation is disabled', () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 1300,
        maxCanonicalTurns: 1300
    });
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

    const input = [
        {role: 'user', content: [{type: 'input_text', text: 'first question'}]},
        {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
        ...Array.from({length: 1200}, (_, i) => ({role: 'user', content: `message ${i}`}))
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', previous_response_id: 'resp_1', input},
        requestType: 'AnthropicViaResponsesWebSocket',
        disableContinuation: true,
        logger: {info() {}}
    });

    assert.equal(result.request.previous_response_id, undefined);
    assert.equal(result.request.input.length, input.length);
    assert.equal(result.request.input[0].content[0].text, 'first question');
    assert.equal(result.request.input.at(-1).content, 'message 1199');
    assert.equal(result.truncated, false);
    assert.equal(result.originalLength, input.length);
    assert.equal(result.retainedLength, input.length);
    assert.equal(result.skipInputItemLimit, true);
    assert.equal(result.autoLink, false);
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

test('prepareResponsesContinuationPayload resets provider chain when previous_response_id would exceed item limit', () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 1200,
        maxCanonicalTurns: 1200
    });
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

    const previousMessages = Array.from({length: 1000}, (_, index) => ({
        role: 'user',
        content: `question ${index}`
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
            id: 'resp_large_chain',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'previous answer'}]
            }]
        }
    });

    const previousInput = [
        ...previousMessages.map((message) => ({
            role: 'user',
            content: [{type: 'input_text', text: message.content}]
        })),
        {role: 'assistant', content: [{type: 'output_text', text: 'previous answer'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                ...previousInput,
                {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
            ]
        },
        requestType: 'ChatCompletionsViaResponsesWS',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.chainReset, true);
    assert.equal(result.autoLink, false);
    assert.equal(result.truncated, true);
    assert.equal('previous_response_id' in result.request, false);
    assert.equal(result.request.input.length, 500);
    assert.deepEqual(result.request.input[0], {
        role: 'user',
        content: [{type: 'input_text', text: 'question 502'}]
    });
    assert.deepEqual(result.request.input.at(-1), {
        role: 'user',
        content: [{type: 'input_text', text: 'latest question'}]
    });
    assert.match(logs.join('\n'), /provider chain input items 1001\+1=1002 exceeds limit 1000/);
});

test('prepareResponsesContinuationPayload uses covered full-history length when stored snapshot is trimmed', () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 200,
        maxCanonicalTurns: 200
    });
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';
    const logs = [];

    const previousMessages = Array.from({length: 1000}, (_, index) => ({
        role: 'user',
        content: `question ${index}`
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
            id: 'resp_trimmed_chain',
            model: 'client-model',
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'previous answer'}]
            }]
        }
    });

    const previousInput = [
        ...previousMessages.map((message) => ({
            role: 'user',
            content: [{type: 'input_text', text: message.content}]
        })),
        {role: 'assistant', content: [{type: 'output_text', text: 'previous answer'}]}
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {
            model: 'glm-5.2',
            input: [
                ...previousInput,
                {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
            ]
        },
        requestType: 'ResponsesWS',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, false);
    assert.equal(result.chainReset, true);
    assert.equal(result.chainInputLength, 1002);
    assert.equal(result.autoLink, false);
    assert.equal(result.truncated, true);
    assert.equal('previous_response_id' in result.request, false);
    assert.equal(result.request.input.length, 500);
    assert.deepEqual(result.request.input.at(-1), {
        role: 'user',
        content: [{type: 'input_text', text: 'latest question'}]
    });
    assert.match(logs.join('\n'), /provider chain input items 1001\+1=1002 exceeds limit 1000/);
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

test('prepareResponsesContinuationPayload matches Ark message wrappers and string content as covered history', () => {
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
                {type: 'message', role: 'user', content: 'first question'},
                {type: 'message', role: 'assistant', content: 'first answer'},
                {type: 'message', role: 'user', content: 'second question'}
            ]
        },
        requestType: 'ChatCompletionViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {type: 'message', role: 'user', content: 'second question'}
    ]);
});

test('prepareResponsesContinuationPayload matches top-level Ark text items as covered history', () => {
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
                {type: 'input_text', text: 'first question'},
                {type: 'output_text', text: 'first answer'},
                {type: 'input_text', text: 'second question'}
            ]
        },
        requestType: 'ChatCompletionViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {type: 'input_text', text: 'second question'}
    ]);
});

test('prepareResponsesContinuationPayload matches Ark tool history with volatile function-call fields', () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 'tenant-a';
    const conversationKey = 'conv-a';

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
                id: 'fc_prev',
                status: 'completed',
                call_id: 'call_read',
                name: 'Read',
                arguments: '{"file_path":"src/services/relay/protocol-adapter.js"}'
            }]
        }
    });

    const fullHistoryInput = [
        {type: 'message', role: 'user', content: 'read relay adapter'},
        {
            type: 'function_call',
            id: 'fc_current_copy',
            status: 'completed',
            call_id: 'call_read',
            name: 'Read',
            arguments: '{"file_path":"src/services/relay/protocol-adapter.js"}'
        },
        {
            type: 'function_call_output',
            call_id: 'call_read',
            output: 'src/services/relay/protocol-adapter.js:30: limitResponsesInputItems'
        }
    ];
    const result = prepareResponsesContinuationPayload({
        conversationStore: store,
        tenantId,
        conversationKey,
        request: {model: 'glm-5.2', input: fullHistoryInput},
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info() {}}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_tool_call');
    assert.deepEqual(result.request.input, fullHistoryInput.slice(2));
});

test('prepareResponsesContinuationPayload uses last response id for fresh input without prefix matching', () => {
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
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'unrelated fresh history'}]}
    ]);
    assert.match(logs.join('\n'), /using previous_response_id/);
    assert.match(logs.join('\n'), /upstream input items=1/);
});

test('prepareResponsesContinuationPayload trims full history to fresh suffix when continuation is enabled', () => {
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
            input: [
                {role: 'user', content: [{type: 'input_text', text: 'rewritten first question'}]},
                {role: 'assistant', content: [{type: 'output_text', text: 'first answer'}]},
                {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
            ]
        },
        requestType: 'AnthropicViaResponsesWebSocket',
        logger: {info: (message) => logs.push(message)}
    });

    assert.equal(result.deltaAttempted, true);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.match(logs.join('\n'), /delta input items 3->1 using previous_response_id/);
    assert.match(logs.join('\n'), /previous_response_id=resp_1/);
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

test('prepareResponsesContinuationPayload does not require covered assistant output to match before continuing', () => {
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

    assert.equal(result.request.previous_response_id, 'resp_1');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'second question'}]}
    ]);
    assert.equal(result.deltaApplied, true);
    assert.equal(result.autoLink, true);
});

test('prepareResponsesContinuationPayload uses latest response id unless a branch id is explicit', () => {
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

    assert.equal(result.request.previous_response_id, 'resp_branch_b');
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

test('prepareResponsesContinuationPayload uses latest response id without scanning older snapshots', () => {
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

    assert.equal(result.request.previous_response_id, 'resp_2');
    assert.deepEqual(result.request.input, [
        {role: 'user', content: [{type: 'input_text', text: 'branch after first'}]}
    ]);
});

test('prepareResponsesContinuationPayload writes direct continuation diagnostics when enabled', () => {
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

        assert.equal(result.deltaApplied, true);
        assert.equal(fs.existsSync(diagFile), true);
        const records = fs.readFileSync(diagFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(records.length, 1);
        assert.equal(records[0].decision, 'delta_applied');
        assert.equal(records[0].conversationKey, conversationKey);
        assert.equal(records[0].requestType, 'AnthropicViaResponsesWebSocket');
        assert.equal(records[0].previousResponseId, 'resp_1');
        assert.equal(records[0].currentInput.itemCount, 1);
        assert.deepEqual(records[0].candidates, []);
        assert.equal('fullInput' in records[0].currentInput, false);
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
