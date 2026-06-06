import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';

import {routeFeedbackAdmin} from '../src/routes/feedback-admin.js';
import {Feedback} from '../src/db/models/feedback.js';

function makeReq(method, url, sessionUser, body = null) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {host: '127.0.0.1'};
    req.socket = {remoteAddress: '127.0.0.1'};
    req.sessionUser = sessionUser;
    process.nextTick(() => {
        if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
    return req;
}

function makeRes() {
    return {
        status: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
        end(data = '') {
            this.body += data;
        }
    };
}

test('ordinary users can update and delete only their own feedback', async () => {
    const originalFindByPk = Feedback.findByPk;
    const owner = {id: 1, username: 'alice', attachments: [], async update(values) { this.values = values; }, async destroy() {}};
    const other = {id: 2, username: 'bob', attachments: [], async update(values) { this.values = values; }, async destroy() {}};
    Feedback.findByPk = async id => Number(id) === 1 ? owner : other;

    try {
        let res = makeRes();
        await routeFeedbackAdmin(
            makeReq('PUT', '/api/feedback/1/status', {username: 'alice', role: 'user'}, {status: 'processing'}),
            res
        );
        assert.equal(res.status, 200);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('PUT', '/api/feedback/2/status', {username: 'alice', role: 'user'}, {status: 'processing'}),
            res
        );
        assert.equal(res.status, 403);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('DELETE', '/api/feedback/2', {username: 'alice', role: 'user'}),
            res
        );
        assert.equal(res.status, 403);

        res = makeRes();
        await routeFeedbackAdmin(
            makeReq('DELETE', '/api/feedback/2', {username: 'admin', role: 'admin'}),
            res
        );
        assert.equal(res.status, 200);
    } finally {
        Feedback.findByPk = originalFindByPk;
    }
});
