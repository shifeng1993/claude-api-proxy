import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'net';
import {detectLdapReachable, _resetAuthModeForTest, initAuthMode, getAuthMode} from '../src/services/shared/auth-mode.js';

function listenOnce() {
    return new Promise(resolve => {
        const srv = createServer().listen(0, '127.0.0.1', () => {
            resolve({port: srv.address().port, close: () => srv.close()});
        });
    });
}

test('detectLdapReachable returns true when host:port accepts TCP', async () => {
    const {port, close} = await listenOnce();
    const ok = await detectLdapReachable(`ldap://127.0.0.1:${port}`, 1000);
    close();
    assert.equal(ok, true);
});

test('detectLdapReachable returns false on connection refused', async () => {
    const ok = await detectLdapReachable('ldap://127.0.0.1:65000', 500);
    assert.equal(ok, false);
});

test('detectLdapReachable returns false on invalid url', async () => {
    const ok = await detectLdapReachable('not-a-url', 500);
    assert.equal(ok, false);
});

test('initAuthMode returns local when LDAP env missing', async () => {
    _resetAuthModeForTest();
    const saved = process.env.LDAP_SERVER;
    delete process.env.LDAP_SERVER;
    try {
        await initAuthMode();
        assert.equal(getAuthMode(), 'local');
    } finally {
        if (saved !== undefined) process.env.LDAP_SERVER = saved;
    }
});

test('initAuthMode returns local when LDAP unreachable', async () => {
    _resetAuthModeForTest();
    const saved = {
        server: process.env.LDAP_SERVER,
        bindDn: process.env.LDAP_BIND_DN,
        bindPw: process.env.LDAP_BIND_PASSWORD,
        baseDn: process.env.LDAP_BASE_DN,
        timeout: process.env.LDAP_PROBE_TIMEOUT_MS
    };
    process.env.LDAP_SERVER = 'ldap://127.0.0.1:65000';
    process.env.LDAP_BIND_DN = 'x';
    process.env.LDAP_BIND_PASSWORD = 'x';
    process.env.LDAP_BASE_DN = 'x';
    process.env.LDAP_PROBE_TIMEOUT_MS = '500';
    try {
        await initAuthMode();
        assert.equal(getAuthMode(), 'local');
    } finally {
        for (const k of Object.keys(saved)) {
            const envKey = {server:'LDAP_SERVER', bindDn:'LDAP_BIND_DN', bindPw:'LDAP_BIND_PASSWORD', baseDn:'LDAP_BASE_DN', timeout:'LDAP_PROBE_TIMEOUT_MS'}[k];
            if (saved[k] === undefined) delete process.env[envKey];
            else process.env[envKey] = saved[k];
        }
    }
});

test('initAuthMode returns ldap when LDAP reachable', async () => {
    _resetAuthModeForTest();
    const {port, close} = await listenOnce();
    const saved = {
        server: process.env.LDAP_SERVER,
        bindDn: process.env.LDAP_BIND_DN,
        bindPw: process.env.LDAP_BIND_PASSWORD,
        baseDn: process.env.LDAP_BASE_DN
    };
    process.env.LDAP_SERVER = `ldap://127.0.0.1:${port}`;
    process.env.LDAP_BIND_DN = 'x';
    process.env.LDAP_BIND_PASSWORD = 'x';
    process.env.LDAP_BASE_DN = 'x';
    try {
        await initAuthMode();
        assert.equal(getAuthMode(), 'ldap');
    } finally {
        close();
        for (const [k, v] of Object.entries(saved)) {
            const envKey = {server:'LDAP_SERVER', bindDn:'LDAP_BIND_DN', bindPw:'LDAP_BIND_PASSWORD', baseDn:'LDAP_BASE_DN'}[k];
            if (v === undefined) delete process.env[envKey];
            else process.env[envKey] = v;
        }
    }
});
