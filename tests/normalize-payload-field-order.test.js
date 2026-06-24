import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePayload} from '../src/protocol-engine/core/shared.js';

test('normalizePayload 按 GLM 前缀缓存要求排列 OpenAI 请求字段', () => {
    const normalized = normalizePayload({
        prompt_cache_key: 'user-key',
        stream_options: {include_usage: true},
        reasoning_effort: 'high',
        tool_choice: 'auto',
        tools: [{type: 'function', function: {name: 'read_file'}}],
        previous_response_id: 'resp_1',
        metadata: {tenant: 't1'},
        thinking: {type: 'disabled'},
        top_p: 0.9,
        stop: ['END'],
        temperature: 0.2,
        max_tokens: 1024,
        stream: true,
        messages: [{role: 'user', content: 'hello'}],
        model: 'glm-5.0-turbo'
    });

    assert.deepEqual(Object.keys(normalized), [
        'model',
        'messages',
        'stream',
        'max_tokens',
        'temperature',
        'stop',
        'top_p',
        'thinking',
        'metadata',
        'previous_response_id',
        'tools',
        'tool_choice',
        'reasoning_effort',
        'prompt_cache_key',
        'stream_options'
    ]);
});
