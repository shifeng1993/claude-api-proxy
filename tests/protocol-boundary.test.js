import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const protocolRoot = path.join(repoRoot, 'src', 'protocol-engine', 'core');
const protocolEngineRoot = path.join(repoRoot, 'src', 'protocol-engine');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

test('protocol engine exposes canonical session and stream APIs from core boundary', async () => {
    assert.equal((await stat(protocolRoot)).isDirectory(), true);

    const protocol = await import(pathToFileURL(path.join(protocolRoot, 'index.js')).href);

    assert.equal(typeof protocol.canonicalFromChatRequest, 'function');
    assert.equal(typeof protocol.renderCanonicalToResponses, 'function');
    assert.equal(typeof protocol.createResponsesToChatStreamBridge, 'function');
    assert.equal(typeof protocol.createChatStreamAccumulator, 'function');
    assert.equal(typeof protocol.analyzeCanonicalToolClosure, 'function');
    assert.equal(typeof protocol.anthropicRequestToChat, 'function');
    assert.equal(typeof protocol.anthropicRequestToResponses, 'function');
    assert.equal(typeof protocol.responsesResponseToAnthropic, 'function');
    assert.equal(typeof protocol.chatRequestToAnthropic, 'function');
    assert.equal(typeof protocol.responsesResponseToRelayChat, 'function');
});

test('protocol engine exposes a public module boundary for app layers', async () => {
    assert.equal((await stat(protocolEngineRoot)).isDirectory(), true);

    const protocolEngine = await import(pathToFileURL(path.join(protocolEngineRoot, 'index.js')).href);

    assert.equal(typeof protocolEngine.canonicalFromChatRequest, 'function');
    assert.equal(typeof protocolEngine.renderCanonicalToResponses, 'function');
    assert.equal(typeof protocolEngine.createResponsesToChatStreamBridge, 'function');
    assert.equal(typeof protocolEngine.createChatStreamAccumulator, 'function');
    assert.equal(typeof protocolEngine.analyzeCanonicalToolClosure, 'function');
    assert.equal(typeof protocolEngine.anthropicRequestToChat, 'function');
    assert.equal(typeof protocolEngine.anthropicRequestToResponses, 'function');
    assert.equal(typeof protocolEngine.responsesResponseToAnthropic, 'function');
    assert.equal(typeof protocolEngine.chatRequestToAnthropic, 'function');
    assert.equal(typeof protocolEngine.responsesResponseToRelayChat, 'function');
});

test('protocol engine declares package metadata for future extraction', async () => {
    const manifest = JSON.parse(
        await readFile(path.join(protocolEngineRoot, 'package.json'), 'utf8')
    );

    assert.equal(manifest.name, '@claude-api-proxy/protocol-engine');
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.main, './index.js');
    assert.deepEqual(manifest.exports, {'.': './index.js'});
    assert.equal(manifest.sideEffects, false);
});

test('root package maps the protocol engine import alias', async () => {
    const manifest = JSON.parse(
        await readFile(path.join(repoRoot, 'package.json'), 'utf8')
    );

    assert.equal(manifest.imports?.['#protocol-engine'], './src/protocol-engine/index.js');
});

test('protocol engine does not import upper application layers', async () => {
    const files = await listJsFiles(protocolRoot);
    assert.ok(files.length > 0, 'expected protocol engine files');

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

test('protocol engine owns protocol schema helpers instead of importing generic utilities', async () => {
    const files = await listJsFiles(protocolRoot);
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*utils\/helpers\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('protocol engine receives behavior rules instead of importing app config', async () => {
    const files = await listJsFiles(protocolRoot);
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*config\/system-prompts\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('protocol engine receives logging hooks instead of importing app logger', async () => {
    const files = await listJsFiles(protocolRoot);
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*utils\/logger\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('legacy transformer directory no longer owns protocol engine files', async () => {
    await assert.rejects(
        stat(path.join(repoRoot, 'src', 'transformer')),
        {code: 'ENOENT'}
    );
});

test('legacy core directory no longer owns protocol engine files', async () => {
    await assert.rejects(
        stat(path.join(repoRoot, 'src', 'core')),
        {code: 'ENOENT'}
    );
});

test('legacy generic converter no longer owns protocol conversion', async () => {
    await assert.rejects(
        stat(path.join(repoRoot, 'src', 'utils', 'converter.js')),
        {code: 'ENOENT'}
    );
});
