import test from 'node:test';
import assert from 'node:assert/strict';
import {createResponsesStreamAccumulator} from '../src/protocol-engine/core/stream/accumulators/responses.js';

test('createResponsesStreamAccumulator rebuilds a final response from responses stream events', () => {
    const accumulator = createResponsesStreamAccumulator({model: 'gpt-test'});

    accumulator.feed('response.created', {
        response: {
            id: 'resp_1',
            model: 'gpt-test',
            created_at: 123,
            output: []
        }
    });
    accumulator.feed('response.output_item.added', {
        output_index: 0,
        item: {type: 'reasoning', id: 'rs_1'}
    });
    accumulator.feed('response.reasoning_summary_text.delta', {
        output_index: 0,
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'think'
    });
    accumulator.feed('response.output_item.done', {
        output_index: 0,
        item: {
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            summary: [{type: 'summary_text', text: 'think'}]
        }
    });
    accumulator.feed('response.output_item.added', {
        output_index: 1,
        item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: []
        }
    });
    accumulator.feed('response.output_text.delta', {
        output_index: 1,
        item_id: 'msg_1',
        content_index: 0,
        delta: 'hello'
    });
    accumulator.feed('response.output_item.done', {
        output_index: 1,
        item: {
            type: 'message',
            id: 'msg_1',
            status: 'completed',
            role: 'assistant',
            content: [{type: 'output_text', text: 'hello', annotations: []}]
        }
    });
    accumulator.feed('response.output_item.added', {
        output_index: 2,
        item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            status: 'in_progress',
            arguments: ''
        }
    });
    accumulator.feed('response.function_call_arguments.delta', {
        output_index: 2,
        item_id: 'fc_1',
        delta: '{"path"'
    });
    accumulator.feed('response.function_call_arguments.done', {
        output_index: 2,
        item_id: 'fc_1',
        arguments: '{"path":"README.md"}'
    });
    accumulator.feed('response.output_item.done', {
        output_index: 2,
        item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            status: 'completed',
            arguments: '{"path":"README.md"}'
        }
    });
    accumulator.feed('response.completed', {
        response: {
            id: 'resp_1',
            status: 'completed',
            model: 'gpt-test',
            usage: {input_tokens: 3, output_tokens: 4, total_tokens: 7}
        }
    });

    assert.deepEqual(accumulator.toResponsesResponse(), {
        id: 'resp_1',
        object: 'response',
        created_at: 123,
        status: 'completed',
        model: 'gpt-test',
        output: [
            {
                type: 'reasoning',
                id: 'rs_1',
                status: 'completed',
                summary: [{type: 'summary_text', text: 'think'}]
            },
            {
                type: 'message',
                id: 'msg_1',
                status: 'completed',
                role: 'assistant',
                content: [{type: 'output_text', text: 'hello', annotations: []}]
            },
            {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'read_file',
                status: 'completed',
                arguments: '{"path":"README.md"}'
            }
        ],
        usage: {input_tokens: 3, output_tokens: 4, total_tokens: 7}
    });
});

test('createResponsesStreamAccumulator finalizes open buffers when completed is missing', () => {
    const accumulator = createResponsesStreamAccumulator({model: 'gpt-test'});

    accumulator.feed('response.created', {
        response: {id: 'resp_1', model: 'gpt-test', created_at: 123}
    });
    accumulator.feed('response.output_item.added', {
        output_index: 0,
        item: {type: 'message', id: 'msg_1', role: 'assistant', content: []}
    });
    accumulator.feed('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_1',
        content_index: 0,
        delta: 'partial text'
    });
    accumulator.feed('response.output_item.added', {
        output_index: 1,
        item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            status: 'in_progress',
            arguments: ''
        }
    });
    accumulator.feed('response.function_call_arguments.delta', {
        output_index: 1,
        item_id: 'fc_1',
        delta: '{"path":"README.md"'
    });

    const response = accumulator.toResponsesResponse();

    assert.equal(response.status, 'incomplete');
    assert.deepEqual(response.output, [
        {
            type: 'message',
            id: 'msg_1',
            status: 'completed',
            role: 'assistant',
            content: [{type: 'output_text', text: 'partial text', annotations: []}]
        },
        {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            status: 'incomplete',
            arguments: '{"path":"README.md"'
        }
    ]);
    assert.deepEqual(accumulator.inspect(), {
        unclosedMessage: true,
        unclosedReasoning: false,
        partialToolArguments: [{
            itemId: 'fc_1',
            callId: 'call_1',
            name: 'read_file',
            bytes: Buffer.byteLength('{"path":"README.md"'),
            validJson: false
        }]
    });
});
