import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildResponsesWebSocketHeaders,
    buildResponsesWebSocketUrl,
    isResponsesUpstream,
    isResponsesWebSocketUpstream
} from '../src/services/relay/api.js';

test('responses_ws protocol is distinct from HTTP responses protocol', () => {
    assert.equal(isResponsesWebSocketUpstream({protocol: 'responses_ws'}), true);
    assert.equal(isResponsesUpstream({protocol: 'responses_ws'}), false);
    assert.equal(isResponsesUpstream({protocol: 'responses'}), true);
});

test('buildResponsesWebSocketUrl converts HTTP endpoint to WS endpoint', () => {
    assert.equal(
        buildResponsesWebSocketUrl({name: 'OpenAI', base_url: 'https://api.example.com/v1'}),
        'wss://api.example.com/v1/responses'
    );
    assert.equal(
        buildResponsesWebSocketUrl({name: 'Local', base_url: 'http://127.0.0.1:3080/v1'}),
        'ws://127.0.0.1:3080/v1/responses'
    );
});

test('buildResponsesWebSocketHeaders uses bearer API key and JSON headers', () => {
    const headers = buildResponsesWebSocketHeaders({name: 'OpenAI', api_key: 'sk-test'});

    assert.equal(headers.Authorization, 'Bearer sk-test');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers.Accept, 'application/json');
});