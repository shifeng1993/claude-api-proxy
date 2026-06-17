import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';
import {
    prepareResponsesWebSocketPayload,
    sendResponsesWebSocketRequest,
    ResponsesWebSocketError
} from '../src/services/shared/responses-ws-client.js';
import {connectionPoolKey} from '../src/services/shared/responses-ws-pool.js';

class FakeWebSocket extends EventEmitter {
    constructor(messages = []) {
        super();
        this.readyState = 1;
        this.messages = messages;
        this.sent = [];
    }

    send(raw) {
        this.sent.push(JSON.parse(raw));
        queueMicrotask(() => {
            for (const message of this.messages) {
                this.emit('message', Buffer.from(JSON.stringify(message)));
            }
        });
    }

    close() {
        this.readyState = 3;
        this.emit('close');
    }
}

test('prepareResponsesWebSocketPayload removes only transport fields unsupported by the WS upstream', () => {
    const payload = prepareResponsesWebSocketPayload({
        model: 'gpt-5.4',
        stream: true,
        background: true,
        store: true,
        metadata: {traceId: 't1'},
        text: {format: {type: 'text'}},
        include: ['reasoning.encrypted_content'],
        truncation: 'auto',
        user: 'user-1',
        generate: false,
        input: 'hello'
    });

    assert.deepEqual(payload, {
        model: 'gpt-5.4',
        store: true,
        metadata: {traceId: 't1'},
        text: {format: {type: 'text'}},
        include: ['reasoning.encrypted_content'],
        truncation: 'auto',
        user: 'user-1',
        generate: false,
        input: 'hello'
    });
});

test('sendResponsesWebSocketRequest sanitizes previous response item ids and tracks last response id', async () => {
    const socket = new FakeWebSocket([
        {type: 'response.created', response: {id: 'resp_1'}},
        {type: 'response.completed', response: {id: 'resp_1', usage: {input_tokens: 1, output_tokens: 2}}}
    ]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: null};

    const events = [];
    for await (const event of sendResponsesWebSocketRequest(connection, {
        model: 'gpt-5.4',
        stream: true,
        input: [
            {
                type: 'message',
                id: 'msg_prev',
                role: 'assistant',
                content: [{type: 'output_text', id: 'part_prev', text: 'old text'}]
            }
        ]
    })) {
        events.push(event.type);
    }

    assert.deepEqual(events, ['response.created', 'response.completed']);
    assert.equal(connection.lastResponseId, 'resp_1');
    assert.equal(socket.sent[0].type, 'response.create');
    assert.equal('stream' in socket.sent[0], false);
    assert.deepEqual(socket.sent[0].input, [
        {
            role: 'assistant',
            content: [{type: 'output_text', text: 'old text'}]
        }
    ]);
});

test('sendResponsesWebSocketRequest injects partial only for doubao-seed prefill models', async () => {
    const socket = new FakeWebSocket([
        {type: 'response.created', response: {id: 'resp_1'}},
        {type: 'response.completed', response: {id: 'resp_1', usage: {input_tokens: 1, output_tokens: 2}}}
    ]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: null};

    for await (const _event of sendResponsesWebSocketRequest(connection, {
        model: 'doubao-seed-1-6-251015',
        input: [{role: 'assistant', content: 'def bubble_sort(arr):'}]
    })) {
    }

    assert.equal(socket.sent[0].input[0].partial, true);
});

test('sendResponsesWebSocketRequest auto-links contextual previous_response_id', async () => {
    const socket = new FakeWebSocket([{type: 'response.completed', response: {id: 'resp_2'}}]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: 'resp_1'};

    for await (const _event of sendResponsesWebSocketRequest(connection, {model: 'gpt-5.4', input: 'continue'})) {
    }

    assert.equal(socket.sent[0].previous_response_id, 'resp_1');
});

test('sendResponsesWebSocketRequest surfaces upstream error events', async () => {
    const socket = new FakeWebSocket([
        {type: 'error', status: 400, error: {message: 'bad request', code: 'bad_request'}}
    ]);

    await assert.rejects(
        async () => {
            for await (const _event of sendResponsesWebSocketRequest(socket, {model: 'gpt-5.4', input: 'hello'})) {
            }
        },
        (error) => error instanceof ResponsesWebSocketError && error.code === 'bad_request'
    );
});

test('connectionPoolKey separates auth and network dimensions', () => {
    const directKey = connectionPoolKey('token-a', 'wss://api.example.com/v1/responses:direct');
    const proxiedKey = connectionPoolKey('token-a', 'wss://api.example.com/v1/responses:http://127.0.0.1:7890');
    const otherTokenKey = connectionPoolKey('token-b', 'wss://api.example.com/v1/responses:direct');

    assert.notEqual(directKey, proxiedKey);
    assert.notEqual(directKey, otherTokenKey);
});
