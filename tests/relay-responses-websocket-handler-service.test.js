import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayResponsesWebSocketHandler} from '../src/services/relay/protocols/responses/websocket.js';
import {
    RelayConversationStore,
    RelayStateMissingError
} from '../src/services/session/conversation-state.js';
import {prepareResponsesContinuationPayload} from '../src/services/session/responses-continuation.js';
import {renderCanonicalToAnthropic} from '../src/protocol-engine/core/canonical/session.js';
import {createAnthropicToResponsesStreamBridge} from '../src/protocol-engine/core/stream/canonical-stream.js';

async function collect(iterable) {
    const events = [];
    for await (const event of iterable) {
        events.push(event);
    }
    return events;
}

async function* chunks(...items) {
    for (const item of items) {
        yield Buffer.from(item);
    }
}

function createBaseDeps(overrides = {}) {
    const calls = [];
    let capturedOptions = null;
    const deps = {
        calls,
        get capturedOptions() {
            return capturedOptions;
        },
        authenticateAndGetUpstream: async () => ({
            upstream: {index: 0},
            tenantId: 42,
            upstreamManager: {
                resolveModel: (model) => `${model}-resolved`
            }
        }),
        tenantDirectory: {
            getTenant: async () => ({name: 'Tenant', username: 'alice'})
        },
        handleWSConnection: (clientWs, options) => {
            calls.push(['handleWSConnection', clientWs]);
            capturedOptions = options;
        },
        recordUsage: (...args) => calls.push(['recordUsage', args]),
        extractConversationKey: () => 'tenant:42:ws',
        isAnthropicUpstream: () => false,
        isResponsesWebSocketUpstream: () => false,
        isResponsesUpstream: () => false,
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {model: request.model, messages: [{role: 'user', content: 'hello'}]},
                conversationKey
            }),
            prepareResponsesPassthrough: ({request, conversationKey}) => ({
                request,
                conversationKey,
                lastResponseId: 'resp_prev'
            })
        },
        RelayStateMissingError: class RelayStateMissingError extends Error {},
        toResponsesWebSocketStateMissingError: (error) => Object.assign(new Error(error.message), {name: 'ResponsesWebSocketError'}),
        invokeWithRelayContextCompaction: async ({chatRequest, invoke}) => ({
            chatRequest,
            result: await invoke(chatRequest)
        }),
        prepareRelayOutboundChatRequest: (request, options) => ({...request, ...options}),
        callUpstream: async (upstream, invoke) => {
            calls.push(['callUpstream', invoke(upstream)]);
            return {response: {body: chunks('data: {"id":"chunk_1"}\n\n')}};
        },
        createChatCompletions: (payload, upstream, meta) => ({payload, upstream, meta}),
        createChatToResponsesStreamBridge: () => ({
            feed: (chunk) => [{
                event: 'response.completed',
                data: {response: {id: `resp_from_${chunk.id}`, usage: {input_tokens: 3, output_tokens: 4}}}
            }]
        }),
        createResponsesStreamAccumulator: () => ({
            feed: (...args) => calls.push(['responsesAccumulator.feed', args]),
            toResponsesResponse: () => ({id: 'resp_accumulated'})
        }),
        recordCompletedResponseState: (...args) => calls.push(['recordCompletedResponseState', args]),
        prepareResponsesContinuationPayload,
        ...overrides
    };
    return deps;
}

test('handleRelayResponsesWS maps upstream auth failures into Responses WebSocket errors', async () => {
    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            error: {status: 503, message: 'No upstream'}
        })
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);

    await assert.rejects(
        () => collect(deps.capturedOptions.handleRequest({model: 'gpt-test'}, null, {signal: {aborted: false}})),
        (error) => {
            assert.equal(error.name, 'ResponsesWebSocketError');
            assert.equal(error.event.error.code, 'no_upstream');
            assert.equal(error.event.error.message, 'No upstream');
            return true;
        }
    );
});

test('handleRelayResponsesWS bridges Chat upstream chunks into Responses WebSocket events', async () => {
    const deps = createBaseDeps();
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({model: 'gpt-test'}, null, {signal: {aborted: false}}));

    assert.deepEqual(events, [{
        type: 'response.completed',
        data: {response: {id: 'resp_from_chunk_1', usage: {input_tokens: 3, output_tokens: 4}}}
    }]);
    assert.deepEqual(
        deps.calls.find((call) => call[0] === 'recordCompletedResponseState')?.[1],
        [42, 'tenant:42:ws', {id: 'resp_from_chunk_1', usage: {input_tokens: 3, output_tokens: 4}}]
    );
    assert.equal(req.relayResolvedModel, 'gpt-test-resolved');
});

test('handleRelayResponsesWS passes native Responses continuation payload through unchanged', async () => {
    let capturedResponsesPayload = null;
    const deps = createBaseDeps({
        isResponsesUpstream: () => true,
        createResponses: (payload) => {
            capturedResponsesPayload = payload;
            return {payload};
        },
        callUpstream: async (upstream, invoke) => {
            deps.calls.push(['callUpstream', invoke(upstream)]);
            return {
                response: {
                    body: chunks(
                        'event: response.completed\n'
                        + 'data: {"type":"response.completed","response":{"id":"resp_native","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
                    )
                }
            };
        },
        parseSSEBlock: (part) => {
            const lines = part.split(/\r?\n/);
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            return {event, data};
        },
        getSSEEventType: (event, parsed) => event || parsed?.type
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        x_relay_anthropic_request: {top_k: 20},
        x_relay_anthropic_thinking_config: {type: 'enabled', budget_tokens: 10000},
        previous_response_id: 'resp_prev',
        input: [{
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'tool result',
            x_relay_anthropic_tool_result: {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: 'tool result'
            }
        }],
        store: false
    }, null, {signal: {aborted: false}}));

    assert.equal(capturedResponsesPayload.model, 'gpt-test-resolved');
    assert.equal(capturedResponsesPayload.previous_response_id, 'resp_prev');
    assert.deepEqual(capturedResponsesPayload.input, [
        {type: 'function_call_output', call_id: 'call_1', output: 'tool result'}
    ]);
    assert.equal(capturedResponsesPayload.x_relay_anthropic_request, undefined);
    assert.equal(capturedResponsesPayload.x_relay_anthropic_thinking_config, undefined);
    assert.equal(capturedResponsesPayload.store, false);
    assert.deepEqual(events, [{
        type: 'response.completed',
        data: {
            type: 'response.completed',
            response: {id: 'resp_native', usage: {input_tokens: 1, output_tokens: 2}}
        }
    }]);
});

test('handleRelayResponsesWS deltas visible full history before forwarding to Responses upstream', async () => {
    const store = new RelayConversationStore({
        ttlMs: 60_000,
        cleanupIntervalMs: 0,
        maxStoredChatMessages: 800,
        maxCanonicalTurns: 800
    });
    const tenantId = 42;
    const conversationKey = 'tenant:42:ws';
    let capturedResponsesPayload = null;

    try {
        const previousMessages = Array.from({length: 600}, (_, index) => ({
            role: 'user',
            content: `question ${index}`
        }));
        store.saveChatRequest({
            tenantId,
            conversationKey,
            request: {model: 'gpt-test-resolved', messages: previousMessages}
        });
        store.recordResponsesResponse({
            tenantId,
            conversationKey,
            response: {
                id: 'resp_1',
                model: 'gpt-test-resolved',
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'previous answer'}]
                }]
            }
        });

        const fullHistoryInput = [
            ...previousMessages.map((message) => ({
                role: 'user',
                content: [{type: 'input_text', text: message.content}]
            })),
            {role: 'assistant', content: [{type: 'output_text', text: 'previous answer'}]},
            {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
        ];
        const deps = createBaseDeps({
            isResponsesUpstream: () => true,
            relayConversationStore: store,
            createResponses: (payload) => {
                capturedResponsesPayload = payload;
                return {payload};
            },
            callUpstream: async (upstream, invoke) => {
                deps.calls.push(['callUpstream', invoke(upstream)]);
                return {
                    response: {
                        body: chunks(
                            'event: response.completed\n'
                            + 'data: {"type":"response.completed","response":{"id":"resp_2","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
                        )
                    }
                };
            },
            parseSSEBlock: (part) => {
                const lines = part.split(/\r?\n/);
                const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
                const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
                return {event, data};
            },
            getSSEEventType: (event, parsed) => event || parsed?.type
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId};

        await handleRelayResponsesWS({id: 'client'}, req);
        await collect(deps.capturedOptions.handleRequest({
            model: 'gpt-test',
            input: fullHistoryInput,
            store: true
        }, null, {signal: {aborted: false}}));

        assert.equal(capturedResponsesPayload.previous_response_id, 'resp_1');
        assert.deepEqual(capturedResponsesPayload.input, [
            {role: 'user', content: [{type: 'input_text', text: 'latest question'}]}
        ]);
    } finally {
        store.dispose();
    }
});

test('handleRelayResponsesWS disables continuation when upstream disables_responses_continuation (Responses upstream)', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 42;
    const conversationKey = 'tenant:42:ws';
    let capturedContinuationOptions = null;
    let capturedResponsesMeta = null;

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'gpt-test-resolved', messages: [{role: 'user', content: 'hi'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'gpt-test-resolved',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'answer'}]}]
        }
    });

    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            upstream: {index: 0, disable_responses_continuation: true},
            tenantId,
            upstreamManager: {resolveModel: (model) => `${model}-resolved`}
        }),
        isResponsesUpstream: () => true,
        relayConversationStore: store,
        prepareResponsesContinuationPayload: (options) => {
            capturedContinuationOptions = options;
            return {
                request: options.request,
                conversationKey: options.conversationKey,
                lastResponseId: 'resp_1',
                autoLink: false,
                skipInputItemLimit: false,
                deltaApplied: false,
                deltaAttempted: false,
                emptyDelta: false,
                deltaPreviousResponseId: null,
                deltaCoveredLength: 0,
                chainReset: false,
                chainInputLength: null,
                chainLimit: null,
                truncated: false,
                originalLength: 1,
                retainedLength: 1,
                droppedCount: 0
            };
        },
        createResponses: (payload, upstream, meta) => {
            capturedResponsesMeta = meta;
            return {payload};
        },
        callUpstream: async (upstream, invoke) => {
            await invoke(upstream);
            return {
                response: {
                    body: chunks(
                        'event: response.completed\n'
                        + 'data: {"type":"response.completed","response":{"id":"resp_2","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
                    )
                }
            };
        },
        parseSSEBlock: (part) => {
            const lines = part.split(/\r?\n/);
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            return {event, data};
        },
        getSSEEventType: (event, parsed) => event || parsed?.type
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId};

    await handleRelayResponsesWS({id: 'client'}, req);
    await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        input: [{role: 'user', content: [{type: 'input_text', text: 'latest question'}]}],
        store: true
    }, null, {signal: {aborted: false}}));

    assert.equal(capturedContinuationOptions.disableContinuation, true);
    assert.equal(capturedResponsesMeta.skipInputItemLimit, true);
    store.dispose();
});

test('handleRelayResponsesWS disables continuation when upstream disables_responses_continuation (Responses WebSocket upstream)', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 42;
    const conversationKey = 'tenant:42:ws';
    let capturedContinuationOptions = null;
    let capturedWsMeta = null;

    store.saveChatRequest({
        tenantId,
        conversationKey,
        request: {model: 'gpt-test-resolved', messages: [{role: 'user', content: 'hi'}]}
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_1',
            model: 'gpt-test-resolved',
            output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'answer'}]}]
        }
    });

    const deps = createBaseDeps({
        authenticateAndGetUpstream: async () => ({
            upstream: {index: 0, disable_responses_continuation: true},
            tenantId,
            upstreamManager: {resolveModel: (model) => `${model}-resolved`}
        }),
        isResponsesWebSocketUpstream: () => true,
        relayConversationStore: store,
        prepareResponsesContinuationPayload: (options) => {
            capturedContinuationOptions = options;
            return {
                request: options.request,
                conversationKey: options.conversationKey,
                lastResponseId: 'resp_1',
                autoLink: false,
                skipInputItemLimit: false,
                deltaApplied: false,
                deltaAttempted: false,
                emptyDelta: false,
                deltaPreviousResponseId: null,
                deltaCoveredLength: 0,
                chainReset: false,
                chainInputLength: null,
                chainLimit: null,
                truncated: false,
                originalLength: 1,
                retainedLength: 1,
                droppedCount: 0
            };
        },
        createResponsesWebSocket: (payload, upstream, meta) => {
            capturedWsMeta = meta;
            return {
                eventStream: (async function* () {
                    yield {type: 'response.completed', data: {response: {id: 'resp_2', usage: {input_tokens: 1, output_tokens: 2}}}};
                })(),
                conn: {release() {}}
            };
        },
        discardResponsesWebSocketConnection: () => {},
        releaseResponsesWebSocketConnection: () => {}
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId};

    await handleRelayResponsesWS({id: 'client'}, req);
    await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        input: [{role: 'user', content: [{type: 'input_text', text: 'latest question'}]}],
        store: true
    }, null, {signal: {aborted: false}}));

    assert.equal(capturedContinuationOptions.disableContinuation, true);
    assert.equal(capturedWsMeta.skipInputItemLimit, true);
    store.dispose();
});

test('handleRelayResponsesWS hydrates tool-result deltas before Anthropic fallback conversion', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 42;
    const conversationKey = 'tenant:42:ws';
    let capturedChatPayload = null;

    store.hydrateResponsesForFullHistory({
        tenantId,
        conversationKey,
        request: {
            model: 'gpt-test-resolved',
            input: [{role: 'user', content: [{type: 'input_text', text: 'read file'}]}]
        }
    });
    store.recordResponsesResponse({
        tenantId,
        conversationKey,
        response: {
            id: 'resp_tool_call',
            model: 'gpt-test-resolved',
            output: [{
                type: 'function_call',
                call_id: 'call_read',
                name: 'Read',
                arguments: '{"file_path":"src/index.js"}'
            }]
        }
    });

    try {
        const deps = createBaseDeps({
            isAnthropicUpstream: () => true,
            relayConversationStore: store,
            chatRequestToAnthropic: (payload) => {
                capturedChatPayload = payload;
                return {messages: payload.messages, stream: payload.stream};
            },
            createAnthropicMessages: (payload, upstream, meta) => ({payload, upstream, meta}),
            getAnthropicRequestHeaders: () => ({}),
            createChatStreamAccumulator: () => ({
                feed: () => {},
                toChatResponse: () => ({choices: [{message: {role: 'assistant', content: 'ok'}}]})
            }),
            streamAnthropicSSEToChatChunks: async function* () {
                yield {id: 'chunk_1'};
            },
            canonicalFromAnthropicStreamChatResponse: () => null
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId};

        await handleRelayResponsesWS({id: 'client'}, req);
        await collect(deps.capturedOptions.handleRequest({
            model: 'gpt-test',
            previous_response_id: 'resp_tool_call',
            input: [
                {type: 'function_call_output', call_id: 'call_read', output: 'file contents'},
                {role: 'assistant', content: [{type: 'output_text', text: 'reminder'}]}
            ]
        }, null, {signal: {aborted: false}}));

        assert.deepEqual(
            capturedChatPayload.messages.map((message) => message.role),
            ['user', 'assistant', 'tool', 'assistant']
        );
        assert.equal(capturedChatPayload.messages[1].tool_calls[0].id, 'call_read');
        assert.equal(capturedChatPayload.messages[2].tool_call_id, 'call_read');
    } finally {
        store.dispose();
    }
});

test('handleRelayResponsesWS converts Chat fallback reasoning into Anthropic thinking', async () => {
    let capturedAnthropicPayload = null;
    const deps = createBaseDeps({
        isAnthropicUpstream: () => true,
        relayConversationStore: {
            hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                chatRequest: {
                    model: request.model,
                    messages: [{role: 'user', content: 'hello'}],
                    reasoning_effort: 'medium',
                    max_tokens: 2000
                },
                conversationKey
            })
        },
        chatRequestToAnthropic: (payload) => ({
            messages: payload.messages,
            max_tokens: payload.max_tokens,
            stream: payload.stream,
            reasoning: {effort: payload.reasoning_effort}
        }),
        createAnthropicMessages: (payload, upstream, meta) => {
            capturedAnthropicPayload = payload;
            return {payload, upstream, meta};
        },
        getAnthropicRequestHeaders: () => ({}),
        createChatStreamAccumulator: () => ({
            feed: () => {},
            toChatResponse: () => ({choices: [{message: {role: 'assistant', content: 'ok'}}]})
        }),
        streamAnthropicSSEToChatChunks: async function* () {
            yield {id: 'chunk_1'};
        },
        canonicalFromAnthropicStreamChatResponse: () => null
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        input: [{role: 'user', content: [{type: 'input_text', text: 'hello'}]}]
    }, null, {signal: {aborted: false}}));

    assert.equal(capturedAnthropicPayload.reasoning, undefined);
    assert.deepEqual(capturedAnthropicPayload.thinking, {
        type: 'enabled',
        budget_tokens: 1999
    });
});

test('handleRelayResponsesWS preserves signed thinking in Anthropic fallback payload', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});
    const tenantId = 42;
    let capturedAnthropicPayload = null;

    try {
        const deps = createBaseDeps({
            isAnthropicUpstream: () => true,
            relayConversationStore: store,
            chatRequestToAnthropic: () => {
                throw new Error('signed thinking must not be bridged through Chat');
            },
            renderCanonicalToAnthropic,
            createAnthropicMessages: (payload, upstream, meta) => {
                capturedAnthropicPayload = payload;
                return {payload, upstream, meta};
            },
            getAnthropicRequestHeaders: () => ({}),
            createChatStreamAccumulator: () => ({
                feed: () => {},
                toChatResponse: () => ({choices: [{message: {role: 'assistant', content: 'ok'}}]})
            }),
            streamAnthropicSSEToChatChunks: async function* () {
                yield {id: 'chunk_1'};
            },
            canonicalFromAnthropicStreamChatResponse: () => null
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId};

        await handleRelayResponsesWS({id: 'client'}, req);
        await collect(deps.capturedOptions.handleRequest({
            model: 'gpt-test',
            x_relay_anthropic_request: {
                system: [{type: 'text', text: 'static instructions', cache_control: {type: 'ephemeral'}}],
                top_k: 20,
                stop_sequences: ['END'],
                metadata: {user_id: 'user-1'},
                tools: [{
                    name: 'read_file',
                    description: 'Read a file',
                    input_schema: {type: 'object', properties: {path: {type: 'string'}}},
                    cache_control: {type: 'ephemeral'}
                }],
                tool_choice: {type: 'auto', disable_parallel_tool_use: true}
            },
            x_relay_anthropic_thinking_config: {type: 'enabled', budget_tokens: 10000},
            input: [
                {
                    role: 'user',
                    content: [{type: 'input_text', text: 'Read README'}],
                    x_relay_anthropic_content: [
                        {type: 'text', text: 'Read README', cache_control: {type: 'ephemeral'}},
                        {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'pdf-data'}}
                    ]
                },
                {
                    type: 'reasoning',
                    summary: [{type: 'summary_text', text: 'Need file.'}],
                    x_relay_anthropic_thinking: [
                        {type: 'thinking', thinking: 'Need file.', signature: 'sig_1'}
                    ]
                },
                {type: 'function_call', call_id: 'toolu_1', name: 'read_file', arguments: '{"path":"README.md"}'},
                {
                    type: 'function_call_output',
                    call_id: 'toolu_1',
                    output: 'README text',
                    x_relay_anthropic_tool_result: {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                        is_error: true,
                        content: [{type: 'text', text: 'README text', cache_control: {type: 'ephemeral'}}],
                        cache_control: {type: 'ephemeral'}
                    }
                }
            ]
        }, null, {signal: {aborted: false}}));

        assert.deepEqual(capturedAnthropicPayload.system, [
            {type: 'text', text: 'static instructions', cache_control: {type: 'ephemeral'}}
        ]);
        assert.equal(capturedAnthropicPayload.top_k, 20);
        assert.deepEqual(capturedAnthropicPayload.stop_sequences, ['END']);
        assert.deepEqual(capturedAnthropicPayload.metadata, {user_id: 'user-1'});
        assert.deepEqual(capturedAnthropicPayload.tools, [{
            name: 'read_file',
            description: 'Read a file',
            input_schema: {type: 'object', properties: {path: {type: 'string'}}},
            cache_control: {type: 'ephemeral'}
        }]);
        assert.deepEqual(capturedAnthropicPayload.tool_choice, {
            type: 'auto',
            disable_parallel_tool_use: true
        });
        assert.deepEqual(capturedAnthropicPayload.messages[0].content, [
            {type: 'text', text: 'Read README', cache_control: {type: 'ephemeral'}},
            {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'pdf-data'}}
        ]);
        assert.deepEqual(capturedAnthropicPayload.messages[1].content[0], {
            type: 'thinking',
            thinking: 'Need file.',
            signature: 'sig_1'
        });
        assert.deepEqual(capturedAnthropicPayload.thinking, {
            type: 'enabled',
            budget_tokens: 10000
        });
        assert.equal(capturedAnthropicPayload.messages[1].content[1].type, 'tool_use');
        assert.deepEqual(capturedAnthropicPayload.messages[2].content[0], {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{type: 'text', text: 'README text', cache_control: {type: 'ephemeral'}}],
            is_error: true,
            cache_control: {type: 'ephemeral'}
        });
    } finally {
        store.dispose();
    }
});

test('handleRelayResponsesWS preserves Anthropic stream thinking signatures in Responses output', async () => {
    let capturedAnthropicPayload = null;
    const parseSSEBlock = (part) => {
        const lines = part.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        return {event, data};
    };
    const deps = createBaseDeps({
        isAnthropicUpstream: () => true,
        chatRequestToAnthropic: (payload) => ({
            messages: payload.messages,
            stream: payload.stream
        }),
        createAnthropicMessages: (payload, upstream, meta) => {
            capturedAnthropicPayload = payload;
            return {payload, upstream, meta};
        },
        getAnthropicRequestHeaders: () => ({}),
        createAnthropicToResponsesStreamBridge,
        parseSSEBlock,
        callUpstream: async (upstream, invoke) => {
            deps.calls.push(['callUpstream', invoke(upstream)]);
            return {
                response: {
                    body: chunks(
                        'event: message_start\n'
                        + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test","usage":{"input_tokens":7,"cache_read_input_tokens":3}}}\n\n',
                        'event: content_block_start\n'
                        + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
                        'event: content_block_delta\n'
                        + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Need file."}}\n\n',
                        'event: content_block_delta\n'
                        + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_real"}}\n\n',
                        'event: content_block_stop\n'
                        + 'data: {"type":"content_block_stop","index":0}\n\n',
                        'event: message_delta\n'
                        + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
                        'event: message_stop\n'
                        + 'data: {"type":"message_stop"}\n\n'
                    )
                }
            };
        }
    });
    const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
    const req = {tenantId: 42};

    await handleRelayResponsesWS({id: 'client'}, req);
    const events = await collect(deps.capturedOptions.handleRequest({
        model: 'gpt-test',
        input: [{role: 'user', content: [{type: 'input_text', text: 'hello'}]}]
    }, null, {signal: {aborted: false}}));

    const reasoningDone = events.find((event) =>
        event.type === 'response.output_item.done'
        && event.data.item.type === 'reasoning'
    );
    assert.deepEqual(reasoningDone.data.item.x_relay_anthropic_thinking, [{
        type: 'thinking',
        thinking: 'Need file.',
        signature: 'sig_real'
    }]);
    const recordedResponse = deps.calls.find((call) => call[0] === 'recordCompletedResponseState')?.[1]?.[2];
    assert.deepEqual(recordedResponse.output[0].x_relay_anthropic_thinking, [{
        type: 'thinking',
        thinking: 'Need file.',
        signature: 'sig_real'
    }]);
    assert.equal(capturedAnthropicPayload.stream, true);
});

test('handleRelayResponsesWS rejects empty Chat fallback without calling upstream', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});

    try {
        const deps = createBaseDeps({
            relayConversationStore: store,
            RelayStateMissingError,
            toResponsesWebSocketStateMissingError: (error) => Object.assign(error, {
                name: 'ResponsesWebSocketError',
                event: {
                    type: 'error',
                    error: {message: error.message, code: 'state_missing'}
                }
            }),
            callUpstream: async () => {
                assert.fail('empty Responses WS input should not be sent to Chat upstream');
            }
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId: 42};

        await handleRelayResponsesWS({id: 'client'}, req);

        await assert.rejects(
            () => collect(deps.capturedOptions.handleRequest({
                model: 'gpt-test',
                input: []
            }, null, {signal: {aborted: false}})),
            (error) => {
                assert.equal(error.name, 'ResponsesWebSocketError');
                assert.equal(error.event.error.code, 'state_missing');
                return true;
            }
        );
    } finally {
        store.dispose();
    }
});

test('handleRelayResponsesWS rejects system-only Chat fallback without calling upstream', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});

    try {
        const deps = createBaseDeps({
            relayConversationStore: {
                hydrateResponsesForFullHistory: ({request, conversationKey}) => ({
                    chatRequest: {model: request.model, messages: [{role: 'system', content: 'relay rules'}]},
                    conversationKey
                })
            },
            RelayStateMissingError,
            toResponsesWebSocketStateMissingError: (error) => Object.assign(error, {
                name: 'ResponsesWebSocketError',
                event: {
                    type: 'error',
                    error: {message: error.message, code: 'state_missing'}
                }
            }),
            callUpstream: async () => {
                assert.fail('system-only Responses WS input should not be sent to Chat upstream');
            }
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId: 42};

        await handleRelayResponsesWS({id: 'client'}, req);

        await assert.rejects(
            () => collect(deps.capturedOptions.handleRequest({
                model: 'gpt-test',
                input: []
            }, null, {signal: {aborted: false}})),
            (error) => {
                assert.equal(error.name, 'ResponsesWebSocketError');
                assert.equal(error.event.error.code, 'state_missing');
                return true;
            }
        );
    } finally {
        store.dispose();
    }
});

test('handleRelayResponsesWS rejects empty Anthropic fallback without calling upstream', async () => {
    const store = new RelayConversationStore({ttlMs: 60_000, cleanupIntervalMs: 0});

    try {
        const deps = createBaseDeps({
            isAnthropicUpstream: () => true,
            relayConversationStore: store,
            RelayStateMissingError,
            toResponsesWebSocketStateMissingError: (error) => Object.assign(error, {
                name: 'ResponsesWebSocketError',
                event: {
                    type: 'error',
                    error: {message: error.message, code: 'state_missing'}
                }
            }),
            callUpstream: async () => {
                assert.fail('empty Responses WS input should not be sent to Anthropic upstream');
            }
        });
        const handleRelayResponsesWS = createRelayResponsesWebSocketHandler(deps);
        const req = {tenantId: 42};

        await handleRelayResponsesWS({id: 'client'}, req);

        await assert.rejects(
            () => collect(deps.capturedOptions.handleRequest({
                model: 'gpt-test',
                input: []
            }, null, {signal: {aborted: false}})),
            (error) => {
                assert.equal(error.name, 'ResponsesWebSocketError');
                assert.equal(error.event.error.code, 'state_missing');
                return true;
            }
        );
    } finally {
        store.dispose();
    }
});
