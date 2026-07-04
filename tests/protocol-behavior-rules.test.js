import test from 'node:test';
import assert from 'node:assert/strict';
import {injectBehaviorRules} from '../src/protocol-engine/core/index.js';

test('injectBehaviorRules uses caller-provided behavior rules', () => {
    const messages = [{role: 'user', content: 'hello'}];

    const result = injectBehaviorRules(messages, undefined, {behaviorRules: 'CUSTOM RULES'});

    assert.deepEqual(result, [
        {role: 'system', content: 'CUSTOM RULES'},
        {role: 'user', content: 'hello'}
    ]);
});

test('injectBehaviorRules normalizes code agent today date line punctuation', () => {
    const messages = [
        {role: 'system', content: 'today‘s date is 2026/07/04\nKeep this line.'},
        {role: 'user', content: 'hello'}
    ];

    const result = injectBehaviorRules(messages, undefined, {behaviorRules: 'CUSTOM RULES'});

    assert.equal(result[0].content, 'CUSTOM RULES\n\ntoday\'s date is 2026-07-04\nKeep this line.');
});

test('injectBehaviorRules normalizes every code agent date apostrophe marker to U+0027', () => {
    const systemContent = [
        "Today's date is 2026-07-04",
        'Today’s date is 2026-07-04',
        'Todayʼs date is 2026-07-04',
        'Todayʹs date is 2026-07-04'
    ].join('\n');

    const result = injectBehaviorRules(
        [
            {role: 'system', content: systemContent},
            {role: 'user', content: 'hello'}
        ],
        undefined,
        {behaviorRules: 'CUSTOM RULES'}
    );

    assert.equal(result[0].content, [
        'CUSTOM RULES',
        '',
        "Today's date is 2026-07-04",
        "Today's date is 2026-07-04",
        "Today's date is 2026-07-04",
        "Today's date is 2026-07-04"
    ].join('\n'));
});
