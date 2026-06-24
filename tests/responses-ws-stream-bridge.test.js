import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createResponsesToResponsesStreamBridge} from '../src/protocol-engine/core/stream/canonical-stream.js';
import {bindAsyncIterableContext, handleWSConnection} from '../src/services/shared/responses-ws-server.js';
import {RelayStateMissingError} from '../src/services/session/conversation-state.js';

test('canonical Responses to Responses bridge adds ordinary scaffold before text deltas', () => {
    const bridge = createResponsesToResponsesStreamBridge({model: 'gpt-5.4'});

    const events = bridge.feed(
        'response.output_text.delta',
        {
            type: 'response.output_text.delta',
            item_id: '+MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX',
            output_index: 0,
            content_index: 0,
            delta: 'hello'
        }
    );

    assert.deepEqual(events.map(event => event.event), [
        'response.created',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta'
    ]);

    const deltaEvent = events.at(-1);
    assert.equal(deltaEvent.data.delta, 'hello');
    assert.notEqual(deltaEvent.data.item_id, '+MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX');
});

test('canonical Responses to Responses bridge includes completed message output for streamed text', () => {
    const bridge = createResponsesToResponsesStreamBridge({model: 'gpt-5.4'});
    const events = [];

    events.push(...bridge.feed(
        'response.output_text.delta',
        {
            type: 'response.output_text.delta',
            item_id: 'upstream_msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'hello'
        }
    ));
    events.push(...bridge.feed(
        'response.completed',
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.4',
                output: [{
                    type: 'message',
                    id: 'upstream_msg_1',
                    status: 'completed',
                    role: 'assistant',
                    content: [{type: 'output_text', text: 'hello', annotations: []}]
                }],
                usage: {input_tokens: 10, output_tokens: 2, total_tokens: 12}
            }
        }
    ));

    const completed = events.at(-1).data.response;
    assert.equal(completed.output.length, 1);
    assert.equal(completed.output[0].type, 'message');
    assert.equal(completed.output[0].role, 'assistant');
    assert.deepEqual(completed.output[0].content, [{type: 'output_text', text: 'hello', annotations: []}]);
});

test('canonical Responses to Responses bridge emits function calls found only in response.completed output', () => {
    const bridge = createResponsesToResponsesStreamBridge({model: 'gpt-5.4'});
    const events = bridge.feed(
        'response.completed',
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'gpt-5.4',
                output: [{
                    type: 'function_call',
                    id: 'fc_1',
                    call_id: 'call_1',
                    name: 'list_files',
                    arguments: '{"path":"."}'
                }],
                usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15}
            }
        }
    );

    assert.deepEqual(events.map(event => event.event), [
        'response.created',
        'response.output_item.added',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
        'response.completed'
    ]);
    assert.equal(events[1].data.item.name, 'list_files');
    assert.equal(events[2].data.delta, '{"path":"."}');
    assert.equal(events[3].data.arguments, '{"path":"."}');
});

test('bindAsyncIterableContext re-enters request context for every iterator step', async () => {
    const calls = [];
    async function* source() {
        calls.push('generator');
        yield {type: 'response.completed'};
    }
    const wrapped = bindAsyncIterableContext(source(), callback => {
        calls.push('context');
        return callback();
    });

    for await (const _event of wrapped) {
        calls.push('consumer');
    }

    assert.deepEqual(calls, ['context', 'generator', 'consumer', 'context']);
});

test('RelayStateMissingError exposes state_missing code for Responses WS errors', () => {
    const error = new RelayStateMissingError('resp_missing');

    assert.equal(error.code, 'state_missing');
    assert.equal(error.previousResponseId, 'resp_missing');
});

test('handleWSConnection accepts response.completed from data.type when wrapper event is message', async () => {
    const ws = new FakeClientWebSocket();

    try {
        handleWSConnection(ws, {
            req: {},
            authenticate: () => ({tenantId: 1}),
            handleRequest: async function* () {
                yield {
                    type: 'message',
                    data: {
                        type: 'response.completed',
                        response: {
                            id: 'resp_1',
                            model: 'glm-5.2',
                            usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3}
                        }
                    }
                };
            }
        });

        ws.emit('message', Buffer.from(JSON.stringify({
            type: 'response.create',
            response: {model: 'glm-5.2', input: 'hello'}
        })));
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.deepEqual(ws.sent.map(event => event.type), ['response.completed']);
    } finally {
        ws.close();
    }
});

class FakeClientWebSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.sent = [];
    }

    send(raw) {
        this.sent.push(JSON.parse(raw));
        return true;
    }

    ping() {}

    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit('close');
    }
}
