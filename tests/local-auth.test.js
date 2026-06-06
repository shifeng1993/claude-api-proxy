import test from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword, verifyPassword} from '../src/services/shared/local-auth.js';

test('hashPassword returns hash and salt as hex strings', () => {
    const {hash, salt} = hashPassword('password123');
    assert.equal(typeof hash, 'string');
    assert.equal(typeof salt, 'string');
    assert.match(hash, /^[0-9a-f]+$/);
    assert.match(salt, /^[0-9a-f]{64}$/);
    assert.ok(hash.length >= 128);
});

test('hashPassword produces different hashes for same input (random salt)', () => {
    const a = hashPassword('password123');
    const b = hashPassword('password123');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
});

test('verifyPassword accepts correct password', () => {
    const {hash, salt} = hashPassword('secret-pw');
    assert.equal(verifyPassword('secret-pw', hash, salt), true);
});

test('verifyPassword rejects wrong password', () => {
    const {hash, salt} = hashPassword('secret-pw');
    assert.equal(verifyPassword('wrong-pw', hash, salt), false);
});

test('verifyPassword returns false for malformed hash without throwing', () => {
    assert.equal(verifyPassword('any', 'not-hex', 'also-not-hex'), false);
});

test('hashPassword throws on non-string input', () => {
    assert.throws(() => hashPassword(null), TypeError);
    assert.throws(() => hashPassword(undefined), TypeError);
    assert.throws(() => hashPassword(123), TypeError);
    assert.throws(() => hashPassword(''), TypeError);
});

import {localAuthenticate} from '../src/services/shared/local-auth.js';

// 简单的内存版 models 替身
function makeMockTenant({hash, salt, role = 'user', name = '本地用户', username = 'alice', service_type = 'relay'}) {
    return {id: 1, username, name, role, password_hash: hash, password_salt: salt, service_type};
}

test('localAuthenticate succeeds with correct password', async () => {
    const {hash, salt} = hashPassword('right-pw');
    const tenant = makeMockTenant({hash, salt});
    const fakeFindOne = async () => tenant;
    const result = await localAuthenticate('alice', 'right-pw', fakeFindOne);
    assert.equal(result.success, true);
    assert.equal(result.username, 'alice');
    assert.equal(result.displayName, '本地用户');
    assert.equal(result.role, 'user');
});

test('localAuthenticate fails with wrong password', async () => {
    const {hash, salt} = hashPassword('right-pw');
    const tenant = makeMockTenant({hash, salt});
    const fakeFindOne = async () => tenant;
    const result = await localAuthenticate('alice', 'wrong-pw', fakeFindOne);
    assert.equal(result.success, false);
    assert.equal(result.message, '用户名或密码错误');
});

test('localAuthenticate fails when user not found', async () => {
    const fakeFindOne = async () => null;
    const result = await localAuthenticate('ghost', 'any', fakeFindOne);
    assert.equal(result.success, false);
    assert.equal(result.message, '用户名或密码错误');
});

test('localAuthenticate fails when account has no password (LDAP user)', async () => {
    const tenant = makeMockTenant({hash: null, salt: null});
    const fakeFindOne = async () => tenant;
    const result = await localAuthenticate('alice', 'any', fakeFindOne);
    assert.equal(result.success, false);
    assert.equal(result.message, '用户名或密码错误');
});
