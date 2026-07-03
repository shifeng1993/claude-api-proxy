import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const sessionRoot = path.join(repoRoot, 'src', 'services', 'session');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('session service exposes conversation and compaction APIs from session boundary', async () => {
    assert.equal((await stat(sessionRoot)).isDirectory(), true);

    const session = await import(pathToFileURL(path.join(sessionRoot, 'index.js')).href);

    assert.equal(typeof session.RelayConversationStore, 'function');
    assert.equal(typeof session.relayConversationStore, 'object');
    assert.equal(typeof session.compactChatRequestIfNeeded, 'function');
    assert.equal(typeof session.prepareResponsesContinuationPayload, 'function');
});

test('session service does not import upper application layers', async () => {
    const files = await listJsFiles(sessionRoot);
    assert.ok(files.length > 0, 'expected session service files');

    const forbiddenImports = [
        /from\s+['"][^'"]*(?:routes|services\/(?:relay|codebuddy|gateway)|db)\//,
        /import\([^)]*['"][^'"]*(?:routes|services\/(?:relay|codebuddy|gateway)|db)\//
    ];

    const violations = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const pattern of forbiddenImports) {
            if (pattern.test(source.replaceAll('\\', '/'))) {
                violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
                break;
            }
        }
    }

    assert.deepEqual(violations, []);
});

test('session service centralizes protocol core imports in its protocol adapter', async () => {
    const files = await listJsFiles(sessionRoot);
    const violations = [];
    const privateProtocolImport = /from\s+['"][^'"]*(?:core\/protocol|protocol-engine\/core|protocol-engine\/index)\.js['"]/;

    for (const file of files) {
        if (path.basename(file) === 'protocol-adapter.js') continue;

        const source = await readFile(file, 'utf8');
        if (privateProtocolImport.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('session protocol adapter imports the protocol engine public module', async () => {
    const adapter = path.join(sessionRoot, 'protocol-adapter.js');
    const source = await readFile(adapter, 'utf8').then((text) => text.replaceAll('\\', '/'));

    assert.match(source, /from\s+['"]#protocol-engine['"]/);
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:core\/protocol|protocol-engine\/core|protocol-engine\/index)\.js['"]/);
});
