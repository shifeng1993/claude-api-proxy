import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const srcRoot = path.join(repoRoot, 'src');
const servicesRoot = path.join(srcRoot, 'services');
const gatewayRoot = path.join(repoRoot, 'src', 'services', 'gateway');
const codebuddyRoot = path.join(repoRoot, 'src', 'services', 'codebuddy');
const sharedRoot = path.join(repoRoot, 'src', 'services', 'shared');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('codebuddy service exposes credential manager from its public boundary', async () => {
    assert.equal((await stat(codebuddyRoot)).isDirectory(), true);

    const codebuddy = await import(pathToFileURL(path.join(codebuddyRoot, 'index.js')).href);

    assert.equal(typeof codebuddy.TenantTokenManager, 'function');
    assert.equal(typeof codebuddy.getCodebuddyCredentialService, 'function');
    assert.equal(typeof codebuddy.createCodebuddyRelayTelemetryHandlers, 'function');
});

test('gateway service exposes auth session and tenant APIs from its public boundary', async () => {
    assert.equal((await stat(gatewayRoot)).isDirectory(), true);

    const gateway = await import(pathToFileURL(path.join(gatewayRoot, 'index.js')).href);

    assert.equal(typeof gateway.authenticateApiKey, 'function');
    assert.equal(typeof gateway.requireApiAuth, 'function');
    assert.equal(typeof gateway.getSessionUser, 'function');
    assert.equal(typeof gateway.createSessionToken, 'function');
    assert.equal(typeof gateway.initAuthMode, 'function');
    assert.equal(typeof gateway.getAuthMode, 'function');
    assert.equal(typeof gateway.localAuthenticate, 'function');
    assert.equal(typeof gateway.ldapAuthenticate, 'function');
    assert.equal(typeof gateway.ensureAdminFromEnv, 'function');
    assert.equal(typeof gateway.unifiedTenantManager, 'object');
    assert.equal(typeof gateway.createLocalUser, 'function');
    assert.equal(typeof gateway.changeOwnLocalUserPassword, 'function');
});

test('gateway imports service managers through public service boundaries', async () => {
    const files = await listJsFiles(gatewayRoot);
    const privateServiceImports = /services\/(?:providers\/upstream-manager|codebuddy\/tenant-token-manager)\.js|from\s+['"]\.\.\/(?:providers\/upstream-manager|codebuddy\/tenant-token-manager)\.js['"]/;
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (privateServiceImports.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('gateway tenant manager does not own CodeBuddy credential managers', async () => {
    const source = await readFile(path.join(gatewayRoot, 'tenant-manager.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /TenantTokenManager/);
    assert.doesNotMatch(source, /codebuddyManagerCache/);
    assert.doesNotMatch(source, /getCodebuddyCredentialManager/);
    assert.doesNotMatch(source, /listCodebuddyCredentials/);
    assert.doesNotMatch(source, /from\s+['"][^'"]*codebuddy[^'"]*['"]/);
});

test('shared services do not import gateway services', async () => {
    const files = await listJsFiles(sharedRoot);
    const violations = [];
    const gatewayImport = /from\s+['"][^'"]*(?:services\/gateway|\.{1,2}\/gateway)[^'"]*['"]/;

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (gatewayImport.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('non-gateway services receive gateway helpers through injection', async () => {
    const files = await listJsFiles(servicesRoot);
    const violations = [];
    const gatewayImport = /from\s+['"][^'"]*(?:services\/gateway|\.{1,2}\/gateway)[^'"]*['"]/;

    for (const file of files) {
        const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
        if (relative.startsWith('src/services/gateway/')) continue;

        const source = await readFile(file, 'utf8').then((text) => text.replaceAll('\\', '/'));
        if (gatewayImport.test(source)) {
            violations.push(relative);
        }
    }

    assert.deepEqual(violations, []);
});

test('app layers import gateway through the public boundary', async () => {
    const files = await listJsFiles(srcRoot);
    const violations = [];
    const privateGatewayImport =
        /from\s+['"][^'"]*(?:services\/gateway|\.{1,2}\/gateway)\/(?:gateway-auth|dashboard-auth|session|tenant-manager)\.js['"]/;

    for (const file of files) {
        const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
        if (relative.startsWith('src/services/gateway/')) continue;

        const source = await readFile(file, 'utf8');
        if (privateGatewayImport.test(source.replaceAll('\\', '/'))) {
            violations.push(relative);
        }
    }

    assert.deepEqual(violations, []);
});
