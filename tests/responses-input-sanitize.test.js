import test from 'node:test';
import assert from 'node:assert/strict';
import {
    limitResponsesInputItems,
    sanitizeResponsesInput,
    truncateResponsesInputItems
} from '../src/transformer/responses-translator.js';

test('sanitizeResponsesInput removes previous response text part references from message content', () => {
    const sanitized = sanitizeResponsesInput(
        [
            {
                type: 'message',
                id: 'msg_prev',
                status: 'completed',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        id: 'MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX',
                        text: 'previous assistant text',
                        annotations: [],
                        status: 'completed'
                    }
                ]
            }
        ],
        'doubao-seed-1-6-251015'
    );

    assert.deepEqual(sanitized, [
        {
            role: 'assistant',
            content: [
                {
                    type: 'output_text',
                    text: 'previous assistant text'
                }
            ],
            partial: true
        }
    ]);
});

test('sanitizeResponsesInput removes nested reference fields that point to previous response parts', () => {
    const sanitized = sanitizeResponsesInput([
        {
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'continue',
                    reference: 'MUL0xll7F6Jf7PoXj7bs2zL9fwEbVS+WMkG94nrgldVxJeLjXybDQpQ3sAlAW762v3sKlG1J217nIIy+NRWx5BXlvZkaIMBOX6JC0otE6jp2orviH1ArMUuMZFn5XVR5ymhayydhxT59/0zJa2dY9R7RikrYTY6W39o4R5rDWLH4tMwHYROgY3G74khcJWHfDFrLdYoZP4/OGqzYA4/OmZvoTdxdHDe7lzIOFvLdsX1fe4nj/lGX6jv3160CHHDeV4IB/Yy3EqMfbLA+XvFPquiO3tKsHbPBwR2zJa8IobpX8BHqzmxZslnrB3ztiWR5TUvbRuBV1Pp31C7hGMGa2x685wr11g6DKTDyZ6SDdR8XnU+KVCuJ7iKefvW50gdzG1mYTevR4MVzHhVk0KunOXRprYM0/Il5YS+KlL9qr9CcCKLCdQo1KUrx7ELrvF2fV29V9dH1OsY+C26Mexcvk/khqvX'
                }
            ]
        }
    ]);

    assert.deepEqual(sanitized, [
        {
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: 'continue'
                }
            ]
        }
    ]);
});

test('sanitizeResponsesInput drops trailing assistant message for non-prefill models (e.g. glm-latest)', () => {
    // 火山引擎 Responses API：不支持 prefill 的模型，input 最后一条不能是 assistant 角色，
    // 否则上游 400 "The last message cannot be from the assistant for a model that does not support prefill"
    // 故对非 doubao-seed 模型，尾部 assistant 消息需被移除，让 input 退回以 user 结尾。
    const input = [
        {role: 'user', content: 'Please write bubble sort code.'},
        {role: 'assistant', content: 'def bubble_sort(arr):'}
    ];

    const sanitized = sanitizeResponsesInput(input, 'glm-latest');

    assert.deepEqual(sanitized, [
        {role: 'user', content: 'Please write bubble sort code.'}
    ]);
});

test('sanitizeResponsesInput injects partial only for doubao-seed models with assistant tail', () => {
    const input = [
        {role: 'user', content: 'continue the code'},
        {role: 'assistant', content: 'def bubble_sort(arr):'}
    ];

    // doubao-seed 系列：注入 partial（续写模式）
    const doubao = sanitizeResponsesInput(input, 'doubao-seed-2-0-lite-260215');
    assert.equal(doubao[1].partial, true);

    // codingplan 网关下的 glm：移除尾部 assistant（不支持 prefill，保留会 400）
    const glm = sanitizeResponsesInput(input, 'glm-latest');
    assert.equal(glm.length, 1);
    assert.equal(glm[0].role, 'user');
    assert.equal(glm[0].partial, undefined);
});

test('truncateResponsesInputItems keeps the recent tail under the item limit at a user boundary', () => {
    const input = [];
    for (let i = 0; i < 600; i++) {
        input.push({role: 'user', content: `question ${i}`});
        input.push({role: 'assistant', content: `answer ${i}`});
    }

    const result = truncateResponsesInputItems(input, {limit: 500});

    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, 1200);
    assert.equal(result.input.length, 500);
    assert.equal(result.input[0].role, 'user');
    assert.equal(result.input[0].content, 'question 350');
});

test('truncateResponsesInputItems moves forward instead of keeping an orphaned tool output', () => {
    const input = [
        {role: 'user', content: 'old'},
        {type: 'function_call', call_id: 'call_old', name: 'old_tool', arguments: '{}'},
        {type: 'function_call_output', call_id: 'call_old', output: 'old result'},
        {role: 'user', content: 'new question'},
        {role: 'assistant', content: 'new answer'},
        {role: 'user', content: 'latest question'},
        {role: 'assistant', content: 'latest answer'}
    ];

    const result = truncateResponsesInputItems(input, {limit: 5});

    assert.equal(result.truncated, true);
    assert.equal(result.input.length <= 5, true);
    assert.deepEqual(result.input.map(item => item.role || item.type), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(result.input[0].content, 'new question');
});

test('limitResponsesInputItems only truncates when a continuation response id is available', () => {
    const input = Array.from({length: 600}, (_, i) => ({role: 'user', content: `message ${i}`}));
    const unchanged = limitResponsesInputItems({model: 'glm-5.2', input}, {limit: 500});

    assert.equal(unchanged.truncated, false);
    assert.equal(unchanged.payload.input.length, 600);
    assert.equal('previous_response_id' in unchanged.payload, false);

    const truncated = limitResponsesInputItems(
        {model: 'glm-5.2', input},
        {limit: 500, previousResponseId: 'resp_prev'}
    );

    assert.equal(truncated.truncated, true);
    assert.equal(truncated.payload.input.length, 500);
    assert.equal(truncated.payload.previous_response_id, 'resp_prev');
    assert.equal(truncated.payload.input[0].content, 'message 100');
});
