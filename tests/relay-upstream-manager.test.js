import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {UpstreamManager} from '../src/services/relay/upstream-manager.js';
import {testRelayUpstream} from '../src/routes/dashboard-frontend.js';

function createServer() {
    return new Promise((resolve, reject) => {
        const server = new WebSocketServer({host: '127.0.0.1', port: 0});
        server.once('error', reject);
        server.once('listening', () => {
            server.off('error', reject);
            resolve(server);
        });
    });
}

test('testUpstream verifies responses_ws upstreams through a WebSocket response', async () => {
    const server = await createServer();
    const port = server.address().port;
    test.after(() => new Promise((resolve) => server.close(resolve)));

    server.on('connection', (socket) => {
        socket.once('message', (raw) => {
            const request = JSON.parse(raw.toString('utf8'));
            assert.equal(request.type, 'response.create');
            assert.equal(request.model, 'gpt-test');

            socket.send(JSON.stringify({
                type: 'response.created',
                response: {id: 'resp_test', model: request.model}
            }));
            socket.send(JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'resp_test',
                    model: request.model,
                    usage: {input_tokens: 1, output_tokens: 1}
                }
            }));
        });
    });

    const manager = new UpstreamManager({tenantId: 1});
    manager.upstreams = [{
        name: 'Local Responses WS',
        protocol: 'responses_ws',
        base_url: `ws://127.0.0.1:${port}/v1`,
        api_key: 'sk-test',
        models: ['gpt-test'],
        enabled: true
    }];

    const result = await manager.testUpstream(0);

    assert.deepEqual(result, {
        success: true,
        message: '连接成功 (protocol: responses_ws, model: gpt-test)'
    });
});

test('testRelayUpstream returns the same result envelope used by batch tests', async () => {
    const manager = new UpstreamManager({tenantId: 1});
    manager.upstreams = [{
        name: 'Single Upstream',
        protocol: 'openai',
        base_url: 'http://127.0.0.1:9/v1',
        api_key: 'sk-test',
        models: ['gpt-test'],
        enabled: true
    }];
    manager.testUpstream = async (index) => ({
        success: index === 0,
        message: `checked ${index}`
    });

    assert.deepEqual(await testRelayUpstream(manager, 0), {
        index: 0,
        name: 'Single Upstream',
        success: true,
        message: 'checked 0'
    });
});

test('testUpstream times out responses_ws streams that never complete', async () => {
    const server = await createServer();
    const port = server.address().port;
    test.after(() => new Promise((resolve) => server.close(resolve)));

    server.on('connection', (socket) => {
        socket.once('message', (raw) => {
            const request = JSON.parse(raw.toString('utf8'));
            assert.equal(request.type, 'response.create');
            socket.send(JSON.stringify({
                type: 'response.created',
                response: {id: 'resp_hanging', model: request.model}
            }));
        });
    });

    const manager = new UpstreamManager({tenantId: 1, testTimeoutMs: 30});
    manager.upstreams = [{
        name: 'Hanging Responses WS',
        protocol: 'responses_ws',
        base_url: `ws://127.0.0.1:${port}/v1`,
        api_key: 'sk-test',
        models: ['gpt-test'],
        enabled: true
    }];

    const result = await manager.testUpstream(0);

    assert.equal(result.success, false);
    assert.match(result.message, /timed out/i);
});
