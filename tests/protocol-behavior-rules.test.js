import test from 'node:test';
import assert from 'node:assert/strict';
import {injectBehaviorRules} from '../src/core/protocol/index.js';

test('injectBehaviorRules uses caller-provided behavior rules', () => {
    const messages = [{role: 'user', content: 'hello'}];

    const result = injectBehaviorRules(messages, undefined, {behaviorRules: 'CUSTOM RULES'});

    assert.deepEqual(result, [
        {role: 'system', content: 'CUSTOM RULES'},
        {role: 'user', content: 'hello'}
    ]);
});
