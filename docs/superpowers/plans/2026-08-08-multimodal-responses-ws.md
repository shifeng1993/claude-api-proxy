# Responses WebSocket Multimodal Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Claude Code and Codex image inputs across Anthropic, Responses WebSocket, Chat, and canonical session conversions, while preventing failed Responses WebSocket response IDs from poisoning automatic continuation.

**Architecture:** Keep the existing Responses WebSocket and connection-pool architecture. Normalize image blocks at the protocol-engine boundary, split images out of Anthropic tool results because `function_call_output.output` is scalar text, and make canonical renderers produce target-native image forms. Track the response ID created by the current WebSocket request and clear it when that request ends with an upstream error.

**Tech Stack:** Node.js 18+, native `node:test`, WebSocket package `ws`, ES modules, existing protocol-engine canonical session and converter modules.

## Global Constraints

- Support Anthropic base64 image sources, Codex/Responses `input_image`, and remote image URLs.
- Remote URLs are passed through unchanged; Relay must not download or cache them.
- Existing Responses WebSocket cascade configuration and connection-pool behavior remain in place.
- `function_call_output.output` remains a string; tool-result images are separate user input items.
- Every production change starts with a failing regression test.
- Existing tests must remain green.

---

### Task 1: Convert Anthropic Tool-Result Images Without JSON-Stringifying Them

**Files:**
- Modify: `tests/protocol-anthropic-responses-converters.test.js`
- Modify: `src/protocol-engine/core/http-converters.js`

**Interfaces:**
- Consumes: Anthropic messages accepted by `anthropicRequestToResponses` and `anthropicRequestToChat`.
- Produces: Responses `function_call_output` plus a following user `input_image` item, and Chat tool content containing text/image blocks.

- [ ] **Step 1: Write the failing Responses conversion test**

Update the test import to include `anthropicRequestToChat`, then append a test that calls `anthropicRequestToResponses` with an assistant `tool_use` followed by a user `tool_result` containing text and an Anthropic base64 image:

```js
test('anthropicRequestToResponses extracts tool_result images into a user input item', () => {
    const converted = anthropicRequestToResponses({
        model: 'kimi-k3',
        messages: [
            {role: 'user', content: 'inspect the screenshot'},
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_image', input: {path: 'screen.png'}}]},
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: [
                        {type: 'text', text: 'screenshot captured'},
                        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
                    ]
                }]
            }
        ]
    });

    const output = converted.input.find((item) => item.type === 'function_call_output');
    assert.equal(output.output, 'screenshot captured');
    const imageItem = converted.input.find((item) =>
        item.role === 'user' && item.content?.some((part) => part.type === 'input_image')
    );
    assert.deepEqual(imageItem.content, [{type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='}]);
});
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `node --test tests/protocol-anthropic-responses-converters.test.js`

Expected: FAIL because the current `function_call_output.output` is the JSON string for the complete text/image array and no separate user image item exists.

- [ ] **Step 3: Write the failing Chat conversion test**

Append a test that calls `anthropicRequestToChat` with the same tool result and asserts the generated tool message content is an array containing a text block and an `image_url` block:

```js
test('anthropicRequestToChat renders tool_result images as image_url content', () => {
    const converted = anthropicRequestToChat({
        model: 'kimi-k3',
        messages: [
            {role: 'user', content: 'inspect the screenshot'},
            {role: 'assistant', content: [{type: 'tool_use', id: 'toolu_1', name: 'read_image', input: {}}]},
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: [
                        {type: 'text', text: 'screenshot captured'},
                        {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
                    ]
                }]
            }
        ]
    });

    assert.deepEqual(converted.messages.find((message) => message.role === 'tool').content, [
        {type: 'text', text: 'screenshot captured'},
        {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}
    ]);
});
```

- [ ] **Step 4: Run the new Chat test and verify it fails for the current JSON-string behavior**

Run: `node --test tests/protocol-anthropic-responses-converters.test.js`

Expected: FAIL because the current tool message content is a JSON string.

- [ ] **Step 5: Implement the minimal converter change**

In `src/protocol-engine/core/http-converters.js`:

1. Add a local helper `mapToolResultContentToChat(content)` next to `handleAnthropicUserMessage`.
2. For string content, return the existing text behavior.
3. For arrays, call the existing `mapContent`; return a scalar joined text string when no image is present, and return the mapped array when it contains `image_url` blocks.
4. In `anthropicMessagesToResponsesInput`, extract `type === 'image'` blocks from `tool_result.content`; construct the scalar output from only string/text blocks; append a user item whose content is produced by `anthropicContentToResponsesContent(imageBlocks)`.
5. Preserve `x_relay_anthropic_tool_result` exactly as the current relay-private-field mechanism does.

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `node --test tests/protocol-anthropic-responses-converters.test.js`

Expected: PASS, including all existing converter tests and both new tool-result image tests.

- [ ] **Step 7: Commit the converter change**

Run:

```powershell
git add tests/protocol-anthropic-responses-converters.test.js src/protocol-engine/core/http-converters.js
git commit -m "fix: preserve Anthropic tool result images"
```

### Task 2: Normalize Codex/Responses Images Through the Canonical Session

**Files:**
- Modify: `tests/protocol-canonical-session.test.js`
- Modify: `src/protocol-engine/core/canonical/session.js`

**Interfaces:**
- Consumes: `canonicalFromResponsesRequest`, `canonicalFromChatRequest`, and `canonicalFromAnthropicRequest` inputs.
- Produces: canonical image blocks and target-native image content from `renderCanonicalToChat`, `renderCanonicalToResponses`, and `renderCanonicalToAnthropic`.

- [ ] **Step 1: Write the failing Codex/Responses image-format test**

Append a test with both string and object `input_image.image_url` forms, then assert canonical rendering keeps the data URL and remote URL:

```js
test('canonical session accepts Codex input_image string and object URLs', () => {
    const session = canonicalFromResponsesRequest({
        model: 'kimi-k3',
        input: [{
            role: 'user',
            content: [
                {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='},
                {type: 'input_image', image_url: {url: 'https://example.test/remote.png'}}
            ]
        }]
    });

    assert.deepEqual(renderCanonicalToChat(session).messages[0].content, [
        {type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}},
        {type: 'image_url', image_url: {url: 'https://example.test/remote.png'}}
    ]);
    assert.deepEqual(renderCanonicalToResponses(session).input[0].content, [
        {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='},
        {type: 'input_image', image_url: 'https://example.test/remote.png'}
    ]);
});
```

- [ ] **Step 2: Run the focused canonical test and verify the expected failure**

Run: `node --test tests/protocol-canonical-session.test.js`

Expected: FAIL because the current object `image_url` becomes an object-valued canonical URL and the current renderer does not normalize data references.

- [ ] **Step 3: Write the failing tool-result round-trip tests**

Append tests covering an Anthropic base64 tool result through canonical Responses rendering and a Chat-origin image tool result through Anthropic rendering. Assert that:

```js
const responseOutput = renderCanonicalToResponses(session).input.find((item) => item.type === 'function_call_output');
assert.equal(responseOutput.output, 'screenshot captured');
assert.deepEqual(renderCanonicalToResponses(session).input.find((item) => item.role === 'user').content, [
    {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='}
]);
```

and:

```js
assert.deepEqual(toolResult.content, [
    {type: 'text', text: 'screenshot captured'},
    {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aGVsbG8='}}
]);
```

- [ ] **Step 4: Run the focused tests and verify they fail before production changes**

Run: `node --test tests/protocol-canonical-session.test.js`

Expected: FAIL because current tool-result renderers JSON-stringify non-scalar content and current image rendering can emit a bare base64 value or an Anthropic URL source for a data URL.

- [ ] **Step 5: Implement the minimal canonical image helpers**

In `src/protocol-engine/core/canonical/session.js`:

1. Add a helper that extracts an image URL from a string or `{url}` object.
2. Add a helper that returns a complete data URL when a canonical image has `dataRef` and `mediaType`, while preserving existing `url` values unchanged.
3. Update `contentToBlocks` and `relayAnthropicContentToBlocks` to normalize `input_image.image_url` string/object values and Anthropic base64 sources into `{type: 'image', mediaType, url, dataRef}`.
4. Update `blocksToChatContent` and `blocksToResponsesContent` to use the normalized image URL helper.
5. Update Anthropic rendering so data URLs become `{type:'base64', media_type, data}` and remote URLs remain `{type:'url', url}`.
6. Add helpers for tool-result content that extract text scalar output plus image blocks for Responses and produce text/image arrays for Chat/Anthropic. Use these helpers in `renderCanonicalToChat`, `renderCanonicalToResponses`, and `anthropicToolResultBlock`.
7. Keep existing relay Anthropic private content and tool mappings intact.

- [ ] **Step 6: Run canonical tests and verify they pass**

Run: `node --test tests/protocol-canonical-session.test.js`

Expected: PASS, including all existing canonical session tests and the new string/object URL and tool-result image tests.

- [ ] **Step 7: Commit the canonical change**

Run:

```powershell
git add tests/protocol-canonical-session.test.js src/protocol-engine/core/canonical/session.js
git commit -m "fix: preserve canonical multimodal content"
```

### Task 3: Invalidate Failed Responses WebSocket Response IDs

**Files:**
- Modify: `tests/responses-ws-client.test.js`
- Modify: `src/services/shared/responses-ws-client.js`

**Interfaces:**
- Consumes: `sendResponsesWebSocketRequest(connection, payload)` and the existing connection object `{ws, contextKey, lastResponseId}`.
- Produces: unchanged successful event streaming, with failed request-created response IDs removed from connection state.

- [ ] **Step 1: Write the failing stale-ID regression test**

Add a test using `FakeWebSocket` with `response.created` followed by a 400 error:

```js
test('sendResponsesWebSocketRequest clears a response id created by a failed request', async () => {
    const socket = new FakeWebSocket([
        {type: 'response.created', response: {id: 'resp_failed'}},
        {type: 'error', status: 400, error: {message: 'invalid image payload', code: 'bad_request'}}
    ]);
    const connection = {ws: socket, contextKey: 'thread-1', lastResponseId: 'resp_previous'};

    await assert.rejects(
        async () => {
            for await (const _event of sendResponsesWebSocketRequest(connection, {
                model: 'kimi-k3',
                input: 'retry after failed image'
            })) {
            }
        },
        (error) => error instanceof ResponsesWebSocketError && error.status === 400
    );

    assert.equal(connection.lastResponseId, null);
});
```

- [ ] **Step 2: Run the focused WebSocket client test and verify it fails**

Run: `node --test tests/responses-ws-client.test.js`

Expected: FAIL because the current error handler only clears the previous ID when it is still equal to `referencedPreviousResponseId`; after `response.created`, it leaves `resp_failed` in the connection.

- [ ] **Step 3: Implement request-scoped response ID invalidation**

In `sendResponsesWebSocketRequest`:

1. Add `requestResponseId = null` beside the existing stream state.
2. On `response.created`, assign `requestResponseId = parsed.response.id` before updating `connection.lastResponseId`.
3. On `error`, clear `connection.lastResponseId` when it equals `requestResponseId`; if no new response ID was created, retain the current behavior of clearing it when it equals `referencedPreviousResponseId`.
4. Do not change successful `response.completed` tracking, payload sanitization, or connection-pool acquisition/release behavior.

- [ ] **Step 4: Run the focused WebSocket client tests and verify they pass**

Run: `node --test tests/responses-ws-client.test.js`

Expected: PASS, including existing auto-link, error propagation, input-limit, and pool-isolation tests.

- [ ] **Step 5: Commit the WebSocket state fix**

Run:

```powershell
git add tests/responses-ws-client.test.js src/services/shared/responses-ws-client.js
git commit -m "fix: clear failed Responses WebSocket ids"
```

### Task 4: Verify the Full Multimodal Cascade Contract

**Files:**
- Modify: `tests/responses-ws-client.test.js`

**Interfaces:**
- Consumes: the completed converter, canonical, and WebSocket client behavior from Tasks 1–3.
- Produces: a regression suite proving the local Relay payload can cross a Responses WebSocket boundary without image download or image loss.

- [ ] **Step 1: Add the transport-boundary regression test**

Use the existing `FakeWebSocket` and `sendResponsesWebSocketRequest` to send one user input item containing a base64 URL and one containing a remote URL. Assert that the JSON captured in `socket.sent[0].input` contains the exact two URLs and no additional fetch or transformation is attempted:

```js
test('Responses WebSocket transport preserves base64 and remote input_image URLs', async () => {
    const socket = new FakeWebSocket([{type: 'response.completed', response: {id: 'resp_image'}}]);

    for await (const _event of sendResponsesWebSocketRequest(socket, {
        model: 'kimi-k3',
        input: [{
            role: 'user',
            content: [
                {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='},
                {type: 'input_image', image_url: 'https://example.test/remote.png'}
            ]
        }]
    })) {
    }

    assert.deepEqual(socket.sent[0].input[0].content, [
        {type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8='},
        {type: 'input_image', image_url: 'https://example.test/remote.png'}
    ]);
});
```

- [ ] **Step 2: Run the transport test and verify it passes**

Run: `node --test tests/responses-ws-client.test.js`

Expected: PASS, demonstrating that the WebSocket boundary forwards both image forms without network access.

- [ ] **Step 3: Run all tests**

Run: `npm.cmd test`

Expected: all tests pass with zero failures, including the new multimodal and stale-ID regressions.

- [ ] **Step 4: Inspect the final diff and working tree**

Run:

```powershell
git diff HEAD~3..HEAD --stat
git status --short --branch
git diff --check HEAD~3..HEAD
```

Expected: only the documented protocol-engine, Responses WebSocket client, and focused test files changed; the working tree is clean.

- [ ] **Step 5: Commit any final test-only adjustment**

If Task 4 required a test adjustment after the full suite, run:

```powershell
git add tests/responses-ws-client.test.js tests/protocol-anthropic-responses-converters.test.js tests/protocol-canonical-session.test.js
git commit -m "test: verify multimodal Responses cascade"
```

Otherwise, keep the three task commits unchanged and report the full-suite result.

## Self-Review Checklist

- Task 1 covers the exact current JSON-stringification bug in both Responses and Chat paths.
- Task 2 covers Anthropic, Codex/Responses, Chat, remote URL, data URL, and tool-result canonical round trips.
- Task 3 covers the observed post-400 connection-pool poisoning behavior.
- Task 4 verifies the WebSocket transport boundary and complete regression suite.
- No task downloads remote images or changes the existing cascade protocol.
- Every production change has a preceding failing test and a focused test command.
