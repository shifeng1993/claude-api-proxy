import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';
import {createSessionToken} from '../src/services/gateway/session.js';

async function startServer(t) {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-routing-test-secret';
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

function sessionHeaders() {
    return {cookie: `cap_session=${createSessionToken('route-test-user', 'user')}`};
}

function adminSessionHeaders() {
    return {cookie: `cap_session=${createSessionToken('route-test-admin', 'admin')}`};
}

test('unauthenticated page routes lead to login and legacy FE routes lead to admin', async t => {
    const base = await startServer(t);

    const root = await fetch(`${base}/`, {redirect: 'manual'});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');

    const admin = await fetch(`${base}/admin`, {redirect: 'manual'});
    assert.equal(admin.status, 302);
    assert.equal(admin.headers.get('location'), '/login');

    const login = await fetch(`${base}/login`, {redirect: 'manual'});
    assert.equal(login.status, 200);
    const loginHtml = await login.text();
    assert.match(loginHtml, /欢迎回来/);
    assert.match(loginHtml, /使用管理员派发的本地账号登录/);
    assert.match(loginHtml, /当前是本地账号认证模式/);
    assert.doesNotMatch(loginHtml, /认证模式由服务启动时的 LDAP 可用性自动决定/);

    const loginSlash = await fetch(`${base}/login/`, {redirect: 'manual'});
    assert.equal(loginSlash.status, 200);

    for (const path of ['/relayFE', '/relayFE/anything', '/codebuddyFE', '/codebuddyFE/anything', '/copilotFE', '/copilotFE/anything']) {
        const response = await fetch(base + path, {redirect: 'manual'});
        assert.equal(response.status, 301);
        assert.equal(response.headers.get('location'), '/admin');
    }
});

test('authenticated users skip login and root forwards to admin', async t => {
    const base = await startServer(t);
    const headers = sessionHeaders();

    const login = await fetch(`${base}/login`, {headers, redirect: 'manual'});
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');

    const root = await fetch(`${base}/`, {headers, redirect: 'manual'});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin');

    const rootWithQuery = await fetch(`${base}/?from=login`, {headers, redirect: 'manual'});
    assert.equal(rootWithQuery.status, 302);
    assert.equal(rootWithQuery.headers.get('location'), '/admin');

    const admin = await fetch(`${base}/admin`, {headers, redirect: 'manual'});
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /统一服务控制台/);

    const missingAdminPage = await fetch(`${base}/admin/unknown-page`, {
        headers: {...headers, accept: 'text/html'}
    });
    assert.equal(missingAdminPage.status, 404);
    assert.match(await missingAdminPage.text(), /这个页面不存在/);
});

test('unknown browser pages render the unified 404 page while APIs keep non-HTML errors', async t => {
    const base = await startServer(t);

    const page = await fetch(`${base}/this-page-does-not-exist`, {
        headers: {accept: 'text/html'}
    });
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /这个页面不存在/);
    assert.match(html, /统一服务控制台/);

    const explicit404 = await fetch(`${base}/404`, {
        headers: {accept: 'text/html'}
    });
    assert.equal(explicit404.status, 404);
    assert.match(await explicit404.text(), /HTTP 404/);

    const api = await fetch(`${base}/missing-api`, {
        headers: {accept: 'application/json'}
    });
    assert.equal(api.status, 404);
    assert.doesNotMatch(api.headers.get('content-type') || '', /text\/html/);
});

test('stats and feedback require a logged-in session but not administrator role', async t => {
    const base = await startServer(t);

    for (const path of ['/stats', '/feedback']) {
        const unauthenticated = await fetch(base + path, {
            headers: {accept: 'text/html'},
            redirect: 'manual'
        });
        assert.equal(unauthenticated.status, 302);
        assert.equal(unauthenticated.headers.get('location'), '/login');

        const ordinaryUser = await fetch(base + path, {
            headers: {...sessionHeaders(), accept: 'text/html'},
            redirect: 'manual'
        });
        assert.equal(ordinaryUser.status, 302);
        assert.equal(
            ordinaryUser.headers.get('location'),
            path === '/stats' ? '/admin#/stats/relay/users' : '/admin#/feedback'
        );

        const administrator = await fetch(base + path, {
            headers: {...adminSessionHeaders(), accept: 'text/html'},
            redirect: 'manual'
        });
        assert.equal(administrator.status, 302);
        assert.equal(
            administrator.headers.get('location'),
            path === '/stats' ? '/admin#/stats/relay/users' : '/admin#/feedback'
        );
    }
});
