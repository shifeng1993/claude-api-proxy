import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';
import {WebSocketServer} from 'ws';
import {
    prepareResponsesWebSocketPayload,
    sendResponsesWebSocketRequest,
    ResponsesWebSocketError
} from '../src/services/shared/responses-ws-client.js';
import {createResponsesWebSocket, discardResponsesWebSocketConnection} from '../src/services/providers/upstream-api.js';
import {
    acquire,
    connectionPoolKey,
    discard,
    release,
    shutdown
} from '../src/services/shared/responses-ws-pool.js';

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
        _skipInputItemLimit: true,
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
        model: 'doubao-seed-1-6-251015',
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
            content: [{type: 'output_text', text: 'old text'}],
            partial: true
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

test('sendResponsesWebSocketRequest truncates oversized input when auto-linking context', async () => {
    const socket = new FakeWebSocket([{type: 'response.completed', response: {id: 'resp_2'}}]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: 'resp_1'};
    const input = Array.from({length: 600}, (_, i) => ({role: 'user', content: `message ${i}`}));

    for await (const _event of sendResponsesWebSocketRequest(connection, {model: 'gpt-5.4', input})) {
    }

    assert.equal(socket.sent[0].previous_response_id, 'resp_1');
    assert.equal(socket.sent[0].input.length, 500);
    assert.equal(socket.sent[0].input[0].content, 'message 100');
    assert.equal(socket.sent[0].input.at(-1).content, 'message 599');
});

test('sendResponsesWebSocketRequest honors disabled auto-linking', async () => {
    const socket = new FakeWebSocket([{type: 'response.completed', response: {id: 'resp_2'}}]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: 'resp_1'};

    for await (const _event of sendResponsesWebSocketRequest(connection, {
        model: 'gpt-5.4',
        input: 'continue',
        _autoLink: false
    })) {
    }

    assert.equal('previous_response_id' in socket.sent[0], false);
    assert.equal('_autoLink' in socket.sent[0], false);
});

test('sendResponsesWebSocketRequest can preserve oversized input when item limit is skipped', async () => {
    const socket = new FakeWebSocket([{type: 'response.completed', response: {id: 'resp_2'}}]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: 'resp_1'};
    const input = Array.from({length: 600}, (_, i) => ({role: 'user', content: `message ${i}`}));

    for await (const _event of sendResponsesWebSocketRequest(connection, {
        model: 'gpt-5.4',
        input,
        _autoLink: false,
        _skipInputItemLimit: true
    })) {
    }

    assert.equal('previous_response_id' in socket.sent[0], false);
    assert.equal('_autoLink' in socket.sent[0], false);
    assert.equal('_skipInputItemLimit' in socket.sent[0], false);
    assert.equal(socket.sent[0].input.length, 600);
    assert.equal(socket.sent[0].input[0].content, 'message 0');
    assert.equal(socket.sent[0].input.at(-1).content, 'message 599');
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

test('sendResponsesWebSocketRequest infers rate limit from legacy server_error messages', async () => {
    const socket = new FakeWebSocket([
        {
            type: 'error',
            error: {
                message: '[upstream]: Anthropic 上游返回 HTTP 429: {"error":{"type":"TooManyRequests"}}',
                code: 'server_error'
            }
        }
    ]);

    await assert.rejects(
        async () => {
            for await (const _event of sendResponsesWebSocketRequest(socket, {model: 'gpt-5.4', input: 'hello'})) {
            }
        },
        (error) =>
            error instanceof ResponsesWebSocketError
            && error.status === 429
            && error.code === 'rate_limit_exceeded'
            && error.event.status === 429
            && error.event.error.code === 'rate_limit_exceeded'
    );
});

test('connectionPoolKey separates auth and network dimensions', () => {
    const directKey = connectionPoolKey('token-a', 'wss://api.example.com/v1/responses:direct');
    const proxiedKey = connectionPoolKey('token-a', 'wss://api.example.com/v1/responses:http://127.0.0.1:7890');
    const otherTokenKey = connectionPoolKey('token-b', 'wss://api.example.com/v1/responses:direct');

    assert.notEqual(directKey, proxiedKey);
    assert.notEqual(directKey, otherTokenKey);
});

test('responses ws pool does not reuse a bound connection for a different context key', async () => {
    const server = await createServer();
    const port = server.address().port;
    const url = `ws://127.0.0.1:${port}/v1/responses`;
    let connA = null;
    let connB = null;

    try {
        connA = await acquire({
            url,
            headers: {},
            authKey: 'sk-test',
            contextKey: 'session-a',
            networkKey: `test-${port}`
        });
        release(connA);

        connB = await acquire({
            url,
            headers: {},
            authKey: 'sk-test',
            contextKey: 'session-b',
            networkKey: `test-${port}`
        });

        assert.notEqual(connA, connB);
    } finally {
        if (connB) discard(connB);
        if (connA && connA !== connB) discard(connA);
        shutdown();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('responses ws pool does not reuse previous_response_id across context keys', async () => {
    const server = await createServer();
    const port = server.address().port;
    const url = `ws://127.0.0.1:${port}/v1/responses`;
    let connA = null;
    let connB = null;

    try {
        connA = await acquire({
            url,
            headers: {},
            authKey: 'sk-test',
            contextKey: 'session-a',
            networkKey: `test-${port}`
        });
        connA.lastResponseId = 'resp_shared';
        release(connA);

        connB = await acquire({
            url,
            headers: {},
            authKey: 'sk-test',
            contextKey: 'session-b',
            preferredPreviousResponseId: 'resp_shared',
            networkKey: `test-${port}`
        });

        assert.notEqual(connA, connB);
        assert.equal(connB.contextKey, 'session-b');
    } finally {
        if (connB) discard(connB);
        if (connA && connA !== connB) discard(connA);
        shutdown();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('createResponsesWebSocket forwards sessionId as X-Session-ID header', async () => {
    let seenSessionId;
    const server = await createServer((req) => {
        seenSessionId = req.headers['x-session-id'];
    });
    const port = server.address().port;
    let result = null;

    try {
        result = await createResponsesWebSocket(
            {model: 'glm-5.2', input: 'hello'},
            {name: 'test-upstream', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'sk-test'},
            {sessionId: 'claude-session-1', contextKey: 'claude-session-1'}
        );

        assert.equal(seenSessionId, 'claude-session-1');
    } finally {
        if (result?.conn) discardResponsesWebSocketConnection(result.conn);
        shutdown();
        await new Promise((resolve) => server.close(resolve));
    }
});

function createServer(onConnection) {
    return new Promise((resolve, reject) => {
        const server = new WebSocketServer({host: '127.0.0.1', port: 0});
        server.on('connection', (_socket, req) => onConnection?.(req));
        server.once('error', reject);
        server.once('listening', () => {
            server.off('error', reject);
            resolve(server);
        });
    });
}
