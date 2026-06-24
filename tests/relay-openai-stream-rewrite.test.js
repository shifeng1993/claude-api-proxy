import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {rewriteOpenAIStream} from '../src/protocol-engine/core/shared.js';

test('rewriteOpenAIStream exposes parsed chunks to an optional callback', async () => {
    const upstream = new PassThrough();
    const parsedChunks = [];
    let usage = null;

    await new Promise((resolve) => {
        const res = {
            writes: [],
            write(chunk) {
                this.writes.push(String(chunk));
            },
            end() {
                resolve();
            }
        };

        rewriteOpenAIStream(
            res,
            upstream,
            (inputTokens, outputTokens, cacheHitTokens) => {
                usage = {inputTokens, outputTokens, cacheHitTokens};
            },
            (chunk) => parsedChunks.push(chunk)
        );

        upstream.write('data: {"id":"chatcmpl_1","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        upstream.write('data: {"id":"chatcmpl_1","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}\n\n');
        upstream.write('data: [DONE]\n\n');
        upstream.end();
    });

    assert.equal(parsedChunks.length, 2);
    assert.equal(parsedChunks[0].choices[0].delta.content, 'hi');
    assert.equal(parsedChunks[1].choices[0].finish_reason, 'stop');
    assert.deepEqual(usage, {inputTokens: 3, outputTokens: 2, cacheHitTokens: 1});
});
