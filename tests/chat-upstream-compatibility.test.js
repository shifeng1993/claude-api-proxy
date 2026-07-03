import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOpenAIChatUpstreamRequest} from '../src/protocol-engine/index.js';

test('prepareOpenAIChatUpstreamRequest strips Codex-only parameters in strict mode', () => {
    const source = {
        model: 'client-model',
        messages: [
            {role: 'developer', content: 'developer instructions'},
            {role: 'user', content: 'hello'}
        ],
        max_completion_tokens: 256,
        reasoning: {effort: 'medium'},
        previous_response_id: 'resp_1',
        store: false,
        metadata: {threadId: 'thread-1'},
        service_tier: 'auto',
        parallel_tool_calls: true,
        response_format: {type: 'json_object'},
        user: 'codex-user',
        tools: [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: {type: 'object'},
                    strict: true
                }
            },
            {type: 'web_search_preview'}
        ],
        tool_choice: {type: 'function', function: {name: 'read_file'}}
    };

    const result = prepareOpenAIChatUpstreamRequest(source, {stripUnknownFields: true});

    assert.notEqual(result, source);
    assert.equal(source.messages[0].role, 'developer');
    assert.equal(result.max_tokens, 256);
    assert.equal(result.reasoning_effort, 'medium');
    assert.equal(result.messages[0].role, 'system');
    assert.deepEqual(result.tools, [{
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {type: 'object'}
        }
    }]);
    assert.deepEqual(result.tool_choice, {type: 'function', function: {name: 'read_file'}});
    for (const field of [
        'max_completion_tokens',
        'reasoning',
        'previous_response_id',
        'store',
        'metadata',
        'service_tier',
        'parallel_tool_calls',
        'response_format',
        'user'
    ]) {
        assert.equal(field in result, false, `${field} should not be sent to a strict Chat upstream`);
    }
});

test('prepareOpenAIChatUpstreamRequest keeps Relay vendor fields in loose mode', () => {
    const source = {
        model: 'relay-model',
        stream: false,
        messages: [{role: 'user', content: 'hello'}],
        previous_response_id: 'resp_1',
        store: false,
        vendor_extension: {trace: true}
    };

    const result = prepareOpenAIChatUpstreamRequest(source);

    assert.deepEqual(source.vendor_extension, {trace: true});
    assert.deepEqual(result.vendor_extension, {trace: true});
    assert.equal('previous_response_id' in result, false);
    assert.equal('store' in result, false);
});
