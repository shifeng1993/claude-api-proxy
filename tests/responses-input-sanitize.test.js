import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeResponsesInput} from '../src/transformer/responses-translator.js';

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

test('sanitizeResponsesInput does NOT inject partial for non-prefill models (e.g. glm-latest)', () => {
    const input = [
        {role: 'user', content: 'Please write bubble sort code.'},
        {role: 'assistant', content: 'def bubble_sort(arr):'}
    ];

    const sanitized = sanitizeResponsesInput(input, 'glm-latest');

    assert.deepEqual(sanitized, [
        {role: 'user', content: 'Please write bubble sort code.'},
        {role: 'assistant', content: 'def bubble_sort(arr):'}
    ]);
    assert.equal(sanitized[1].partial, undefined);
});

test('sanitizeResponsesInput injects partial only for doubao-seed models with assistant tail', () => {
    const input = [
        {role: 'user', content: 'continue the code'},
        {role: 'assistant', content: 'def bubble_sort(arr):'}
    ];

    // doubao-seed 系列：注入 partial（续写模式）
    const doubao = sanitizeResponsesInput(input, 'doubao-seed-2-0-lite-260215');
    assert.equal(doubao[1].partial, true);

    // codingplan 网关下的 glm：不注入 partial（不支持 prefill，会报 400）
    const glm = sanitizeResponsesInput(input, 'glm-latest');
    assert.equal(glm[1].partial, undefined);
});
