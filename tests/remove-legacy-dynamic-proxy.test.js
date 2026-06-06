import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const root = process.cwd();

test('legacy dynamic provider proxy entry is removed', () => {
    assert.equal(existsSync(join(root, 'src/router.js')), false);
    assert.equal(existsSync(join(root, 'src/transformer/index.js')), false);
    assert.equal(existsSync(join(root, 'src/transformer/claude-to-openai.js')), false);

    const server = readFileSync(join(root, 'src/server.js'), 'utf8');
    assert.equal(server.includes('parseRoute'), false);
    assert.equal(server.includes('getTransformer'), false);
    assert.equal(server.includes('handleProxyRequest'), false);
    assert.equal(server.includes("endsWith('/v1/messages')"), false);
});
