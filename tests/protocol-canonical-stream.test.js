import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAnthropicToChatStreamBridge,
    createChatToAnthropicStreamBridge,
    createChatToResponsesStreamBridge,
    createResponsesToAnthropicStreamBridge,
    createResponsesToResponsesStreamBridge,
    createResponsesToChatStreamBridge,
    chatChunkToCanonicalStreamEvents,
    createAnthropicCanonicalStreamState,
    createCanonicalToResponsesStreamState,
    createResponsesCanonicalStreamState,
    responsesEventToCanonicalStreamEvents,
    anthropicEventToCanonicalStreamEvents,
    renderCanonicalStreamEventsToResponsesEvents
} from '../src/protocol-engine/core/stream/canonical-stream.js';

test('responses stream events are normalized to canonical stream events', () => {
    const state = createResponsesCanonicalStreamState({model: 'gpt-test'});

    const created = responsesEventToCanonicalStreamEvents('response.created', {
        response: {id: 'resp_1', model: 'gpt-test'}
    }, state);
    const reasoning = responsesEventToCanonicalStreamEvents('response.reasoning_summary_text.delta', {
        item_id: 'rs_1',
        delta: 'think'
    }, state);
    const text = responsesEventToCanonicalStreamEvents('response.output_text.delta', {
        item_id: 'msg_1',
        delta: 'hello'
    }, state);
    responsesEventToCanonicalStreamEvents('response.output_item.added', {
        item: {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file'}
    }, state);
    const toolDelta = responsesEventToCanonicalStreamEvents('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        delta: '{"path":"README.md"}'
    }, state);

    assert.deepEqual(created, [{type: 'metadata', responseId: 'resp_1', model: 'gpt-test'}]);
    assert.deepEqual(reasoning, [{type: 'reasoning_delta', text: 'think'}]);
    assert.deepEqual(text, [{type: 'text_delta', text: 'hello'}]);
    assert.equal(toolDelta.length, 1);
    assert.equal(toolDelta[0].type, 'tool_call_arguments_delta');
    assert.equal(toolDelta[0].canonicalToolCallId, 'ctc_1');
    assert.equal(toolDelta[0].ids.responsesItemId, 'fc_1');
    assert.equal(toolDelta[0].ids.responsesCallId, 'call_1');
    assert.equal(toolDelta[0].argumentsDelta, '{"path":"README.md"}');
});

test('chat stream reasoning ignores non-text thinking payload objects', () => {
    const events = chatChunkToCanonicalStreamEvents({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{
            delta: {
                thinking: {type: 'enabled'}
            },
            finish_reason: null
        }]
    });

    assert.equal(events.some((event) => event.text === '[object Object]'), false);
    assert.equal(events.some((event) => event.type === 'reasoning_delta'), false);
});

test('canonical stream bridge renders Responses text and tools as Chat chunks', () => {
    const bridge = createResponsesToChatStreamBridge({model: 'gpt-test'});
    const chunks = [];

    chunks.push(...bridge.feed('response.created', {
        response: {id: 'resp_1', model: 'gpt-test'}
    }));
    chunks.push(...bridge.feed('response.output_text.delta', {
        item_id: 'msg_1',
        delta: 'hello'
    }));
    chunks.push(...bridge.feed('response.output_item.added', {
        item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: ''
        }
    }));
    chunks.push(...bridge.feed('response.function_call_arguments.delta', {
        item_id: 'fc_1',
        delta: '{"path"'
    }));
    chunks.push(...bridge.feed('response.function_call_arguments.done', {
        item_id: 'fc_1',
        arguments: '{"path":"README.md"}'
    }));
    chunks.push(...bridge.feed('response.completed', {
        response: {
            id: 'resp_1',
            model: 'gpt-test',
            usage: {input_tokens: 3, output_tokens: 4, total_tokens: 7}
        }
    }));

    assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta), [
        {role: 'assistant'},
        {content: 'hello'},
        {
            tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {name: 'read_file', arguments: ''}
            }]
        },
        {
            tool_calls: [{
                index: 0,
                function: {arguments: '{"path"'}
            }]
        },
        {
            tool_calls: [{
                index: 0,
                function: {arguments: ':"README.md"}'}
            }]
        },
        {}
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks.at(-1).usage, {
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7,
        prompt_tokens_details: {cached_tokens: 0},
        completion_tokens_details: {reasoning_tokens: 0}
    });
});

test('canonical stream bridge emits tool calls that only appear in response.completed', () => {
    const bridge = createResponsesToChatStreamBridge({model: 'gpt-test'});

    const chunks = bridge.feed('response.completed', {
        response: {
            id: 'resp_1',
            model: 'gpt-test',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'list_files',
                arguments: '{"path":"."}'
            }],
            usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}
        }
    });

    assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta), [
        {role: 'assistant'},
        {
            tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {name: 'list_files', arguments: ''}
            }]
        },
        {
            tool_calls: [{
                index: 0,
                function: {arguments: '{"path":"."}'}
            }]
        },
        {}
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('canonical stream bridge renders Responses text and completed tools as Anthropic events', () => {
    const bridge = createResponsesToAnthropicStreamBridge({model: 'gpt-test'});
    const events = [];

    events.push(...bridge.feed('response.created', {
        response: {id: 'resp_1', model: 'gpt-test'}
    }));
    events.push(...bridge.feed('response.output_text.delta', {
        item_id: 'msg_1',
        delta: 'hello'
    }));
    events.push(...bridge.feed('response.completed', {
        response: {
            id: 'resp_1',
            model: 'gpt-test',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"README.md"}'
            }],
            usage: {
                input_tokens: 3,
                output_tokens: 4,
                total_tokens: 7,
                input_tokens_details: {cached_tokens: 1}
            }
        }
    }));

    assert.deepEqual(events.map((event) => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop'
    ]);
    assert.deepEqual(events[2].delta, {type: 'text_delta', text: 'hello'});
    assert.deepEqual(events[4].content_block, {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: {}
    });
    assert.deepEqual(events[5].delta, {
        type: 'input_json_delta',
        partial_json: '{"path":"README.md"}'
    });
    assert.equal(events[7].delta.stop_reason, 'tool_use');
    assert.deepEqual(events[7].usage, {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 1
    });
});

test('canonical stream bridge renders Chat reasoning text and tools as Responses events', () => {
    const bridge = createChatToResponsesStreamBridge({model: 'gpt-test'});
    const events = [];

    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{delta: {role: 'assistant'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{delta: {reasoning_content: 'think'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{delta: {content: 'hello'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: ''}
                }]
            },
            finish_reason: null
        }]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: '{"path"'}
                }]
            },
            finish_reason: null
        }]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'gpt-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: ':"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7}
    }));

    assert.deepEqual(events.map((event) => event.event), [
        'response.created',
        'response.output_item.added',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_part.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.content_part.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.completed'
    ]);

    const completed = events.at(-1).data.response;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.model, 'gpt-test');
    assert.deepEqual(completed.usage, {
        input_tokens: 3,
        output_tokens: 4,
        total_tokens: 7,
        input_tokens_details: {cached_tokens: 0},
        output_tokens_details: {reasoning_tokens: 0}
    });
    assert.equal(completed.output[0].type, 'reasoning');
    assert.equal(completed.output[1].type, 'message');
    assert.equal(completed.output[2].type, 'function_call');
    assert.equal(completed.output[2].arguments, '{"path":"README.md"}');
});

test('canonical stream bridge renders unsigned Chat reasoning as Anthropic thinking', () => {
    const bridge = createChatToAnthropicStreamBridge({model: 'claude-test'});
    const events = [];

    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {role: 'assistant'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {reasoning_content: 'think'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{delta: {content: 'hello'}, finish_reason: null}]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: ''}
                }]
            },
            finish_reason: null
        }]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: '{"path"'}
                }]
            },
            finish_reason: null
        }]
    }));
    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: {arguments: ':"README.md"}'}
                }]
            },
            finish_reason: 'tool_calls'
        }],
        usage: {prompt_tokens: 3, completion_tokens: 4, total_tokens: 7}
    }));

    assert.deepEqual(events.map((event) => event.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop'
    ]);
    assert.equal(events[0].message.id, 'chatcmpl_1');
    assert.equal(events[1].content_block.type, 'thinking');
    assert.deepEqual(events[2].delta, {type: 'thinking_delta', thinking: 'think'});
    assert.equal(events[3].delta.type, 'signature_delta');
    assert.ok(events[3].delta.signature);
    assert.equal(events[5].content_block.type, 'text');
    assert.deepEqual(events[6].delta, {type: 'text_delta', text: 'hello'});
    assert.deepEqual(events[8].content_block, {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: {}
    });
    assert.deepEqual(events[9].delta, {type: 'input_json_delta', partial_json: '{"path"'});
    assert.deepEqual(events[10].delta, {type: 'input_json_delta', partial_json: ':"README.md"}'});
    assert.equal(events[12].delta.stop_reason, 'tool_use');
    assert.deepEqual(events[12].usage, {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 0
    });
});

test('Anthropic to Responses stream bridge preserves real thinking signatures', () => {
    const anthropicState = createAnthropicCanonicalStreamState({model: 'claude-test'});
    const responsesState = createCanonicalToResponsesStreamState({model: 'claude-test'});
    const events = [];
    const feed = (eventName, eventData) => {
        const canonical = anthropicEventToCanonicalStreamEvents(eventName, eventData, anthropicState);
        events.push(...renderCanonicalStreamEventsToResponsesEvents(canonical, responsesState));
    };

    feed('message_start', {
        message: {
            id: 'msg_1',
            model: 'claude-test',
            usage: {input_tokens: 3}
        }
    });
    feed('content_block_start', {
        index: 0,
        content_block: {type: 'thinking', thinking: ''}
    });
    feed('content_block_delta', {
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'think'}
    });
    feed('content_block_delta', {
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig_real'}
    });
    feed('content_block_stop', {index: 0});
    feed('content_block_start', {
        index: 1,
        content_block: {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {}}
    });
    feed('content_block_delta', {
        index: 1,
        delta: {type: 'input_json_delta', partial_json: '{"path":"README.md"}'}
    });
    feed('message_delta', {
        delta: {stop_reason: 'tool_use'},
        usage: {output_tokens: 5}
    });

    const doneItem = events.find((event) =>
        event.event === 'response.output_item.done'
        && event.data.item.type === 'reasoning'
    ).data.item;
    assert.deepEqual(doneItem.x_relay_anthropic_thinking, [{
        type: 'thinking',
        thinking: 'think',
        signature: 'sig_real'
    }]);
    assert.deepEqual(events.at(-1).data.response.output[0].x_relay_anthropic_thinking, [{
        type: 'thinking',
        thinking: 'think',
        signature: 'sig_real'
    }]);
});

test('Responses to Anthropic stream bridge replays real thinking signatures without fabricating one', () => {
    const bridge = createResponsesToAnthropicStreamBridge({model: 'claude-test'});
    const events = [];

    events.push(...bridge.feed('response.reasoning_summary_text.delta', {
        item_id: 'rs_1',
        delta: 'think'
    }));
    events.push(...bridge.feed('response.output_item.done', {
        output_index: 0,
        item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{type: 'summary_text', text: 'think'}],
            x_relay_anthropic_thinking: [{
                type: 'thinking',
                thinking: 'think',
                signature: 'sig_real'
            }]
        }
    }));
    events.push(...bridge.feed('response.completed', {
        response: {
            id: 'resp_1',
            model: 'claude-test',
            output: [],
            usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}
        }
    }));

    const signatureEvents = events.filter((event) => event.delta?.type === 'signature_delta');
    assert.deepEqual(signatureEvents.map((event) => event.delta.signature), ['sig_real']);
});

test('Responses to Anthropic stream bridge renders unsigned reasoning summaries as thinking', () => {
    const bridge = createResponsesToAnthropicStreamBridge({model: 'claude-test'});
    const events = [];

    events.push(...bridge.feed('response.reasoning_summary_text.delta', {
        item_id: 'rs_1',
        delta: 'unsigned thought'
    }));
    events.push(...bridge.feed('response.output_item.done', {
        output_index: 0,
        item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{type: 'summary_text', text: 'unsigned thought'}]
        }
    }));
    events.push(...bridge.feed('response.output_text.delta', {
        item_id: 'msg_1',
        delta: 'visible'
    }));
    events.push(...bridge.feed('response.completed', {
        response: {
            id: 'resp_1',
            model: 'claude-test',
            output: [],
            usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}
        }
    }));

    assert.equal(
        events.some((event) => event.content_block?.type === 'thinking'),
        true
    );
    assert.deepEqual(
        events.find((event) => event.delta?.type === 'thinking_delta').delta,
        {type: 'thinking_delta', thinking: 'unsigned thought'}
    );
    assert.equal(
        events.some((event) => event.delta?.type === 'signature_delta'),
        true
    );
    assert.equal(
        events.some((event) => event.content_block?.type === 'text'),
        true
    );
});

test('Chat to Anthropic stream fallback finishes tool calls as tool_use', () => {
    const bridge = createChatToAnthropicStreamBridge({model: 'claude-test'});
    const events = [];

    events.push(...bridge.feed({
        id: 'chatcmpl_1',
        model: 'claude-test',
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {name: 'read_file', arguments: '{"path":"README.md"}'}
                }]
            },
            finish_reason: null
        }]
    }));
    events.push(...bridge.finish());

    const messageDelta = events.find((event) => event.type === 'message_delta');
    assert.equal(messageDelta.delta.stop_reason, 'tool_use');
});

test('canonical stream bridge renders Anthropic reasoning text and tools as Chat chunks', () => {
    const bridge = createAnthropicToChatStreamBridge({model: 'claude-test'});
    const chunks = [];

    chunks.push(...bridge.feed('message_start', {
        message: {
            id: 'msg_1',
            model: 'claude-test',
            usage: {input_tokens: 3, cache_read_input_tokens: 1}
        }
    }));
    chunks.push(...bridge.feed('content_block_delta', {
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'think'}
    }));
    chunks.push(...bridge.feed('content_block_delta', {
        index: 1,
        delta: {type: 'text_delta', text: 'hello'}
    }));
    chunks.push(...bridge.feed('content_block_start', {
        index: 2,
        content_block: {type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {}}
    }));
    chunks.push(...bridge.feed('content_block_delta', {
        index: 2,
        delta: {type: 'input_json_delta', partial_json: '{"path":"README.md"}'}
    }));
    chunks.push(...bridge.feed('message_delta', {
        delta: {stop_reason: 'tool_use', stop_sequence: null},
        usage: {output_tokens: 5}
    }));

    assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta), [
        {role: 'assistant'},
        {reasoning_content: 'think'},
        {content: 'hello'},
        {
            tool_calls: [{
                index: 0,
                id: 'toolu_1',
                type: 'function',
                function: {name: 'read_file', arguments: ''}
            }]
        },
        {
            tool_calls: [{
                index: 0,
                function: {arguments: '{"path":"README.md"}'}
            }]
        },
        {}
    ]);
    assert.equal(chunks[0].id, 'msg_1');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks.at(-1).usage, {
        prompt_tokens: 4,
        completion_tokens: 5,
        total_tokens: 9,
        prompt_tokens_details: {cached_tokens: 1},
        completion_tokens_details: {reasoning_tokens: 0}
    });
});

test('canonical stream bridge renders Responses stream back to Responses events', () => {
    const bridge = createResponsesToResponsesStreamBridge({model: 'gpt-test'});
    const events = [];

    events.push(...bridge.feed('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'upstream_msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'hello'
    }));
    events.push(...bridge.feed('response.completed', {
        type: 'response.completed',
        response: {
            id: 'resp_1',
            model: 'gpt-test',
            output: [{
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'list_files',
                arguments: '{"path":"."}'
            }],
            usage: {input_tokens: 2, output_tokens: 3, total_tokens: 5}
        }
    }));

    assert.deepEqual(events.map((event) => event.event), [
        'response.created',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.content_part.done',
        'response.output_item.done',
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.completed'
    ]);
    assert.equal(events[3].data.delta, 'hello');
    assert.equal(events[6].data.item.call_id, 'call_1');
    assert.equal(events[7].data.delta, '{"path":"."}');
    assert.equal(events.at(-1).data.response.output.at(-1).arguments, '{"path":"."}');
});
