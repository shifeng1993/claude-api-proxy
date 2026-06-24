import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const gatewayRoot = path.join(repoRoot, 'src', 'services', 'gateway');
const codebuddyRoot = path.join(repoRoot, 'src', 'services', 'codebuddy');

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
