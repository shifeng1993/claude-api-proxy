import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import {setLogLevel} from '../src/utils/logger.js';
import {request, isNetworkError, UpstreamNetworkError} from '../src/utils/http-client.js';

setLogLevel('none');

test('request wraps timeout failures as upstream network errors', async () => {
    const server = http.createServer((_req, _res) => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
        const {port} = server.address();
        await assert.rejects(
            request(`http://127.0.0.1:${port}`, {timeout: 20}),
            (error) => {
                assert.equal(error.name, 'UpstreamNetworkError');
                assert.equal(error.code, 'ETIMEDOUT');
                assert.equal(isNetworkError(error), true);
                return true;
            }
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('isNetworkError recognizes wrapped upstream network errors', () => {
    const error = new UpstreamNetworkError('connection failed', 'ECONNRESET');
    assert.equal(isNetworkError(error), true);
});
