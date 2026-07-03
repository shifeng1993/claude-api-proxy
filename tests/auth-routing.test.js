import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'fs';
import {createServer} from '../src/server.js';
import {clearSessionCookie, createSessionToken, setSessionCookie} from '../src/services/gateway/index.js';
import {DASHBOARD_ENTRY_PATH, resolveLoginRole} from '../src/routes/auth.js';

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

function superAdminSessionHeaders() {
    return {cookie: `cap_session=${createSessionToken('route-test-root', 'superadmin')}`};
}

test('dashboard entry path includes the default dashboard hash route', () => {
    assert.equal(DASHBOARD_ENTRY_PATH, '/dashboard#/relay');
});

test('browser templates fall back to the default dashboard hash route', () => {
    const adminHtml = readFileSync('src/templates/admin.html', 'utf8');
    const loginHtml = readFileSync('src/templates/login.html', 'utf8');

    assert.match(adminHtml, /if\(!location\.hash\|\|!location\.hash\.startsWith\('#\/'\)\)syncHashRoute\('relay',null,\{replace:true\}\);/);
    assert.match(loginHtml, /data\.redirect\|\|'\/dashboard#\/relay'/);
});

test('browser page API calls stay on the same host under the api namespace', () => {
    const adminHtml = readFileSync('src/templates/admin.html', 'utf8');
    const loginHtml = readFileSync('src/templates/login.html', 'utf8');

    for (const html of [adminHtml, loginHtml]) {
        assert.match(html, /function pageApiOrigin\(\)/);
        assert.doesNotMatch(html, /api\.shifeng1993\.com/);
        assert.match(html, /function apiUrl\(path\)/);
        assert.match(html, /\/api/);
        assert.match(html, /(?:fetch|fetchWithTimeout)\(apiUrl\(/);
        assert.match(html, /credentials:'include'/);
    }
});

test('session cookies are shared across shifeng1993 subdomains', () => {
    const headers = {};
    const res = {setHeader: (name, value) => { headers[name] = value; }};

    setSessionCookie(res, 'token-value', {headers: {host: 'relay.shifeng1993.com'}});

    assert.match(headers['Set-Cookie'], /Domain=\.shifeng1993\.com/);
    assert.match(headers['Set-Cookie'], /Secure/);
    assert.match(headers['Set-Cookie'], /SameSite=Strict/);
});

test('logout clears both shared-domain and host-only session cookies', () => {
    const headers = {};
    const res = {setHeader: (name, value) => { headers[name] = value; }};

    clearSessionCookie(res, {headers: {host: 'relay.shifeng1993.com'}});

    assert.ok(Array.isArray(headers['Set-Cookie']));
    assert.equal(headers['Set-Cookie'].length, 2);
    assert.match(headers['Set-Cookie'][0], /Domain=\.shifeng1993\.com/);
    assert.doesNotMatch(headers['Set-Cookie'][1], /Domain=/);
    assert.ok(headers['Set-Cookie'].every(cookie => /cap_session=/.test(cookie) && /Max-Age=0/.test(cookie)));
});

test('server allows dashboard pages to call the api namespace with credentials', async t => {
    const base = await startServer(t);
    const response = await fetch(`${base}/stats/api/overview`, {
        method: 'OPTIONS',
        headers: {
            origin: 'https://relay.shifeng1993.com',
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'content-type'
        }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://relay.shifeng1993.com');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('access-control-allow-methods') || '', /GET/);
});

test('coding-prefixed protocol routes are normalized before service auth', async t => {
    const base = await startServer(t);

    for (const prefix of ['/coding', '/api/coding']) {
        for (const service of ['relay', 'codebuddy']) {
            const response = await fetch(`${base}${prefix}/${service}`, {
                headers: {accept: 'application/json'}
            });
            const body = await response.json();

            assert.ok([401, 503].includes(response.status));
            assert.ok(['authentication_error', 'service_unavailable'].includes(body.error.type));
        }
    }
});

test('api-prefixed dashboard and usage routes are normalized before page session auth', async t => {
    const base = await startServer(t);

    const stats = await fetch(`${base}/api/usage/overview`, {
        headers: {accept: 'application/json'}
    });
    assert.equal(stats.status, 401);
    assert.equal(await stats.text(), 'Authentication required');

    const dashboard = await fetch(`${base}/api/dashboard/me`, {
        headers: {accept: 'application/json'}
    });
    assert.equal(dashboard.status, 401);
    assert.match(await dashboard.text(), /登录|过期/);
});

test('usage API is available to the current signed-in user regardless of role', async t => {
    const base = await startServer(t);

    const response = await fetch(`${base}/api/usage/overview?service=relay`, {
        headers: {
            ...sessionHeaders(),
            accept: 'application/json',
            'x-forwarded-for': '203.0.113.10'
        }
    });

    assert.notEqual(response.status, 403);

    const adminResponse = await fetch(`${base}/api/usage/overview?service=relay`, {
        headers: {
            ...adminSessionHeaders(),
            accept: 'application/json',
            'x-forwarded-for': '203.0.113.10'
        }
    });

    assert.notEqual(adminResponse.status, 403);

    const superAdminResponse = await fetch(`${base}/api/usage/overview?service=relay`, {
        headers: {
            ...superAdminSessionHeaders(),
            accept: 'application/json',
            'x-forwarded-for': '203.0.113.10'
        }
    });

    assert.notEqual(superAdminResponse.status, 403);

    const otherUserDetail = await fetch(`${base}/api/usage/user-detail?service=relay&username=someone-else`, {
        headers: {
            ...adminSessionHeaders(),
            accept: 'application/json'
        }
    });

    assert.equal(otherUserDetail.status, 403);
});

test('unauthenticated page routes lead to login and legacy FE routes lead to dashboard', async t => {
    const base = await startServer(t);

    const root = await fetch(`${base}/`, {redirect: 'manual'});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');

    const dashboard = await fetch(`${base}/dashboard`, {redirect: 'manual'});
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/login');

    const login = await fetch(`${base}/login`, {redirect: 'manual'});
    assert.equal(login.status, 200);
    assert.match(await login.text(), /loginForm/);

    const loginSlash = await fetch(`${base}/login/`, {redirect: 'manual'});
    assert.equal(loginSlash.status, 200);

    for (const path of ['/relayFE', '/relayFE/anything', '/codebuddyFE', '/codebuddyFE/anything']) {
        const response = await fetch(base + path, {redirect: 'manual'});
        assert.equal(response.status, 301);
        assert.equal(response.headers.get('location'), '/dashboard');
    }
});

test('authenticated users skip login and root forwards to dashboard entry', async t => {
    const base = await startServer(t);
    const headers = sessionHeaders();

    const login = await fetch(`${base}/login`, {headers, redirect: 'manual'});
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), DASHBOARD_ENTRY_PATH);

    const root = await fetch(`${base}/`, {headers, redirect: 'manual'});
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), DASHBOARD_ENTRY_PATH);

    const rootWithQuery = await fetch(`${base}/?from=login`, {headers, redirect: 'manual'});
    assert.equal(rootWithQuery.status, 302);
    assert.equal(rootWithQuery.headers.get('location'), DASHBOARD_ENTRY_PATH);

    const dashboard = await fetch(`${base}/dashboard`, {headers, redirect: 'manual'});
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /routeFromHash/);

    const missingDashboardPage = await fetch(`${base}/dashboard/unknown-page`, {
        headers: {...headers, accept: 'text/html'}
    });
    assert.equal(missingDashboardPage.status, 404);
    assert.match(await missingDashboardPage.text(), /HTTP 404/);
});

test('unknown browser pages render the unified 404 page while APIs keep non-HTML errors', async t => {
    const base = await startServer(t);

    const page = await fetch(`${base}/this-page-does-not-exist`, {
        headers: {accept: 'text/html'}
    });
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /HTTP 404/);

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

test('feedback requires a logged-in session but not administrator role', async t => {
    const base = await startServer(t);

    for (const path of ['/feedback']) {
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
        assert.equal(ordinaryUser.headers.get('location'), '/dashboard#/feedback');

        const administrator = await fetch(base + path, {
            headers: {...adminSessionHeaders(), accept: 'text/html'},
            redirect: 'manual'
        });
        assert.equal(administrator.status, 302);
        assert.equal(administrator.headers.get('location'), '/dashboard#/feedback');
    }
});

test('legacy standalone upload routes are removed', async t => {
    const base = await startServer(t);

    const page = await fetch(`${base}/uploadFE`, {
        headers: {accept: 'text/html'},
        redirect: 'manual'
    });
    assert.equal(page.status, 404);
    assert.match(await page.text(), /HTTP 404/);

    const api = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {...sessionHeaders(), accept: 'application/json'}
    });
    assert.equal(api.status, 404);

    const serverSource = readFileSync('src/server.js', 'utf8');
    assert.doesNotMatch(serverSource, /\/uploadFE|\/api\/upload|Busboy/);
});

test('stats root no longer serves a standalone dashboard page', async t => {
    const base = await startServer(t);

    const unauthenticated = await fetch(`${base}/stats`, {
        headers: {accept: 'text/html'},
        redirect: 'manual'
    });
    assert.equal(unauthenticated.status, 404);
    assert.match(await unauthenticated.text(), /HTTP 404/);

    const ordinaryUser = await fetch(`${base}/stats`, {
        headers: {...sessionHeaders(), accept: 'text/html'},
        redirect: 'manual'
    });
    assert.equal(ordinaryUser.status, 404);
    assert.match(await ordinaryUser.text(), /HTTP 404/);

    const administrator = await fetch(`${base}/stats`, {
        headers: {...adminSessionHeaders(), accept: 'text/html'},
        redirect: 'manual'
    });
    assert.equal(administrator.status, 404);
    assert.match(await administrator.text(), /HTTP 404/);
});

test('LDAP login uses the persisted tenant role for the session', async () => {
    const calls = [];
    const role = await resolveLoginRole({
        authMode: 'ldap',
        username: 'root',
        displayName: 'Root User',
        resultRole: undefined,
        tenantManager: {
            createTenantForUser: async (username, displayName) => {
                calls.push({username, displayName});
                return 12;
            },
            getTenant: id => ({id, username: 'root', role: 'superadmin'})
        }
    });

    assert.equal(role, 'superadmin');
    assert.deepEqual(calls, [{username: 'root', displayName: 'Root User'}]);
});
