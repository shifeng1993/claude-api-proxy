import test from 'node:test';
import assert from 'node:assert/strict';
import {stripDynamicReminders} from '../src/protocol-engine/core/shared.js';

test('preserves Claude Code session identity and resume context', () => {
    const result = stripDynamicReminders([{
        role: 'user',
        content: [
            '<session-id>session-a</session-id>',
            '<session_knowledge>project context</session_knowledge>',
            'SessionStart:startup hook success:',
            'Last active: 2026-06-04T12:00:00Z',
            'Continue from where you left off.',
            'Real question'
        ].join('\n')
    }]);

    assert.ok(result[0].content.includes('<session-id>session-a</session-id>'));
    assert.ok(result[0].content.includes('<session_knowledge>project context</session_knowledge>'));
    assert.ok(result[0].content.includes('SessionStart:startup hook success:'));
    assert.ok(!result[0].content.includes('Last active:'));
    assert.ok(result[0].content.includes('Continue from where you left off.'));
    assert.ok(result[0].content.includes('Real question'));
});

test('preserves session-id in array text content', () => {
    const result = stripDynamicReminders([{
        role: 'user',
        content: [{type: 'text', text: '<session-id>session-b</session-id>\nHello'}]
    }]);

    assert.equal(result[0].content[0].text, '<session-id>session-b</session-id>\nHello');
});

test('removes only Last active lines from user and tool text', () => {
    const result = stripDynamicReminders([
        {role: 'user', content: 'Last active: 2026-06-04T12:00:00Z\nHello'},
        {role: 'tool', tool_call_id: 'x', content: 'Result\nLast active: 2026-06-04T12:00:00Z\nDone'}
    ]);

    assert.equal(result[0].content, 'Hello');
    assert.equal(result[1].content, 'Result\nDone');
});

test('preserves bookkeeping system-reminders because they affect model behavior', () => {
    const result = stripDynamicReminders([
        {role: 'user', content: 'Hello\n\n<system-reminder>\nToken usage: 1234\nUSD budget: $5\n</system-reminder>'},
        {role: 'tool', tool_call_id: 'x', content: 'Result\n\n<system-reminder>\ncache_read: 0\n</system-reminder>'}
    ]);

    assert.ok(result[0].content.includes('Token usage: 1234'));
    assert.ok(result[0].content.includes('USD budget: $5'));
    assert.ok(result[1].content.includes('cache_read: 0'));
});

test('does not relocate skills hooks mcp or deferred tool reminders', () => {
    const result = stripDynamicReminders([
        {role: 'user', content: 'First user message'},
        {role: 'assistant', content: 'Ok'},
        {
            role: 'user',
            content: [
                '<system-reminder>',
                '<available-skills>skill2\nskill1</available-skills>',
                '</system-reminder>',
                'Second user message'
            ].join('\n')
        },
        {
            role: 'user',
            content: '<system-reminder>\nhook success: PreToolUse\n</system-reminder>\nThird user message'
        }
    ]);

    const userMessages = result.filter((message) => message.role === 'user');
    assert.equal(userMessages[0].content, 'First user message');
    assert.ok(userMessages[1].content.includes('<available-skills>skill2\nskill1</available-skills>'));
    assert.ok(userMessages[1].content.includes('Second user message'));
    assert.ok(userMessages[2].content.includes('hook success: PreToolUse'));
    assert.ok(userMessages[2].content.includes('Third user message'));
});

test('keeps microcompact sentinel text unchanged', () => {
    const content = '[Old tool result content cleared at 2026-04-30T13:42:11Z]\nOther content';
    const result = stripDynamicReminders([{role: 'tool', tool_call_id: 'x', content}]);

    assert.equal(result[0].content, content);
});

test('does not touch assistant messages', () => {
    const result = stripDynamicReminders([
        {role: 'assistant', content: '<session-id>assistant-session</session-id>\nX'}
    ]);

    assert.equal(result[0].content, '<session-id>assistant-session</session-id>\nX');
});

test('returns non-array inputs unchanged', () => {
    assert.equal(stripDynamicReminders(null), null);
    assert.equal(stripDynamicReminders('hello'), 'hello');
    assert.deepEqual(stripDynamicReminders([]), []);
});
