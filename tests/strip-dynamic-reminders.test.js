import test from 'node:test';
import assert from 'node:assert/strict';
import {stripDynamicReminders} from '../src/transformer/shared-translator.js';

// ── P0: 身份归一化 ──

test('保留 <session_knowledge> 标签', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<session_knowledge>some dynamic stuff</session_knowledge>\nReal content'}
    ]);
    assert.ok(r[0].content.includes('session_knowledge'));
    assert.ok(r[0].content.includes('Real content'));
});

// SessionStart 不再归一化：它在前缀 3000 字符之外，归一化对缓存无意义；
// 且实际变体是 "SessionStart hook additional context:"，startup/resume 归一化根本匹配不到
test('SessionStart 原样保留（不在前缀内，无需归一化）', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'SessionStart:startup hook success:\nSome stable content'}
    ]);
    assert.equal(r[0].content, 'SessionStart:startup hook success:\nSome stable content');
});

test('移除 <session-id> 标签', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<session-id>abc123</session-id>Hello'}
    ]);
    assert.ok(!r[0].content.includes('session-id'));
    assert.ok(r[0].content.includes('Hello'));
});

test('移除 Last active 行', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'Last active: 2026-06-04T12:00:00Z\nHello'}
    ]);
    assert.equal(r[0].content, 'Hello');
});

test('保留尾部 Continue from where you left off', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'Some content\n\nContinue from where you left off.'}
    ]);
    assert.ok(r[0].content.includes('Continue from where you left off.'));
});

test('完整身份归一化组合', () => {
    const r = stripDynamicReminders([{
        role: 'user',
        content: '<session_knowledge>dyn</session_knowledge>\nSessionStart:startup hook success:\n\nLast active: 2026-06-04T12:00:00Z\n\nContinue from where you left off.\nReal question'
    }]);
    assert.ok(r[0].content.includes('session_knowledge'), 'session_knowledge 保留');
    assert.ok(!r[0].content.includes('session-id'), 'session-id 已移除');
    assert.ok(!r[0].content.includes('Last active'), 'Last active 已移除');
    assert.ok(r[0].content.includes('Continue from'), 'Continue from 保留');
    assert.ok(r[0].content.includes('Real question'));
    assert.ok(r[0].content.includes('SessionStart'), 'SessionStart 保留原值');
});

// ── P0: 可重定位块归位 ──

test('skills 块归位到第一条 user 消息', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'First user message'},
        {role: 'assistant', content: 'Ok'},
        {role: 'user', content: '<system-reminder>\n<available-skills>skill1,skill2</available-skills>\n</system-reminder>\nSecond user message'}
    ]);
    const userMsgs = r.filter(m => m.role === 'user');
    assert.ok(userMsgs[0].content.includes('available-skills'));
    assert.ok(userMsgs[0].content.includes('First user message'));
    assert.equal(userMsgs[1].content, 'Second user message');
});

test('hooks 块归位到第一条 user 消息', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'Start'},
        {role: 'assistant', content: 'ok'},
        {role: 'user', content: '<system-reminder>\nhook success: PreToolUse\n</system-reminder>\nQ1'}
    ]);
    const userMsgs = r.filter(m => m.role === 'user');
    assert.ok(userMsgs[0].content.includes('hook success'));
    assert.equal(userMsgs[1].content, 'Q1');
});

// 只归位前 2 条 user 消息中的块，后续保持原位
test('可重定位块按 deferred → mcp → skills → hooks 排序（前两条 user 内）', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<system-reminder>\n<deferred-tools>bash</deferred-tools>\n</system-reminder>\nStart'},
        {role: 'user', content: '<system-reminder>\nhook success: X\n</system-reminder>\n<system-reminder>\n<available-skills>A</available-skills>\n</system-reminder>\nQ1'}
    ]);
    const first = r.filter(m => m.role === 'user')[0].content;
    const defPos = first.indexOf('deferred-tools');
    const skillsPos = first.indexOf('available-skills');
    const hooksPos = first.indexOf('hook success');
    assert.ok(defPos < skillsPos, 'deferred should come before skills');
    assert.ok(skillsPos < hooksPos, 'skills should come before hooks');
});

test('第三条及之后的 user 消息中的块保持原位不归位', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'First'},
        {role: 'user', content: 'Second'},
        {role: 'user', content: '<system-reminder>\n<available-skills>late-skill</available-skills>\n</system-reminder>\nThird question'}
    ]);
    const userMsgs = r.filter(m => m.role === 'user');
    // 第一条不应包含第三条的 skills
    assert.ok(!userMsgs[0].content.includes('late-skill'), '第三条的 skills 不应归位到第一条');
    // 第三条保持原样
    assert.ok(userMsgs[2].content.includes('available-skills'), '第三条的 skills 应保持原位');
    assert.ok(userMsgs[2].content.includes('Third question'));
});

// ── P1: microcompact 哨兵归一化 ──

test('microcompact 哨兵归一化（移除时间戳）', () => {
    const r = stripDynamicReminders([
        {role: 'tool', tool_call_id: 'x', content: '[Old tool result content cleared]\nOther content'}
    ]);
    assert.equal(r[0].content, '[Old tool result content cleared]\nOther content');
});

test('microcompact 在 user 消息中也生效', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '[Old tool result content cleared]\nY'}
    ]);
    assert.equal(r[0].content, '[Old tool result content cleared]\nY');
});

// ── P1: tool 消息中的记账 reminder 剥离 ──

test('tool 消息中的 Token usage reminder 被剥离', () => {
    const r = stripDynamicReminders([
        {role: 'tool', tool_call_id: 'x', content: 'Result\n\n<system-reminder>\nToken usage: 1234\n</system-reminder>'}
    ]);
    assert.equal(r[0].content, 'Result');
});

test('tool 消息中的 budget reminder 被剥离', () => {
    const r = stripDynamicReminders([
        {role: 'tool', tool_call_id: 'x', content: 'Result\n\n<system-reminder>\nUSD budget: $5\n</system-reminder>'}
    ]);
    assert.equal(r[0].content, 'Result');
});

// ── 既有功能：记账 reminder 剥离（user 消息）──

test('user 消息中的 Token usage reminder 被剥离', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'Hello\n\n<system-reminder>\nToken usage: 1234\n</system-reminder>'}
    ]);
    assert.equal(r[0].content, 'Hello');
});

test('非记账 reminder 保留', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: 'Hello\n\n<system-reminder>\nImportant: do X\n</system-reminder>'}
    ]);
    assert.ok(r[0].content.includes('Important: do X'));
});

// currentDate 不再被记账模式剥离
test('含 currentDate 的 system-reminder 不被当作记账块剥离', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<system-reminder>\n# currentDate\n2026-06-05\n</system-reminder>'}
    ]);
    assert.equal(r.length, 1);
    assert.ok(r[0].content.includes('currentDate'));
});

// ── 边界场景 ──

test('assistant 消息不被处理', () => {
    const r = stripDynamicReminders([
        {role: 'assistant', content: '<session_knowledge>abc</session_knowledge>\nX'}
    ]);
    assert.equal(r[0].content, '<session_knowledge>abc</session_knowledge>\nX');
});

test('数组形式 content 的 session_knowledge 保留', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: [{type: 'text', text: '<session_knowledge>abc</session_knowledge>\nHello'}]}
    ]);
    assert.ok(r[0].content[0].text.includes('session_knowledge'), 'session_knowledge 保留');
    assert.ok(r[0].content[0].text.includes('Hello'));
});

test('仅含 session_knowledge 的消息保留', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<session_knowledge>only content</session_knowledge>'}
    ]);
    assert.equal(r.length, 1);
    assert.ok(r[0].content.includes('session_knowledge'));
});

test('仅含记账 reminder 的消息被移除', () => {
    const r = stripDynamicReminders([
        {role: 'user', content: '<system-reminder>\nToken usage: 999\n</system-reminder>'}
    ]);
    assert.equal(r.length, 0);
});

test('null 输入直接返回', () => {
    assert.equal(stripDynamicReminders(null), null);
});

test('非数组输入直接返回', () => {
    assert.equal(stripDynamicReminders('hello'), 'hello');
});

test('空数组返回空数组', () => {
    const r = stripDynamicReminders([]);
    assert.deepEqual(r, []);
});