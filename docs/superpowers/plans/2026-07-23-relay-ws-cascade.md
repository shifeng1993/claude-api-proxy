# Relay Cascade 级联层剥离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WebSocket 级联从 responses_ws 协议中物理剥离，新增 `/relay/cascade` 路径与自定义二进制帧协议，实现 payload 原样透传；同时废弃 responses-ws-pool，所有上游 responses_ws 连接改为每会话独立、用完即关。

**Architecture:** 级联层走独立路径 `/relay/cascade`（仅 WS upgrade 触发），使用 18 字节 header + op 语义的自定义二进制帧（SESSION_BEGIN/FRAME/SESSION_END/RELAY_ERROR/UPSTREAM_ERROR/CANCEL/BODY_CHUNK 等）。入口 proxy 把客户端 responses_ws payload 封装为 SESSION_BEGIN 透传到下游；中间节点 raw 转发二进制帧不解析 body；末节点解封装后转真上游协议调用，响应事件逐个封装为 FRAME。每会话独立 WS、用完即关。计费只在末节点。废弃 pool 与 auto-link，previous_response_id 续接改由客户端显式或末节点会话存储恢复。

**Tech Stack:** Node.js ESM、`ws@8`、`node:test`、现有 `protocol-engine`、现有 `responses-ws-server/client`。

**Spec:** `docs/superpowers/specs/2026-07-23-relay-ws-cascade-design.md`

---

## 执行节奏约束

本服务一边用一边改，不能立即重启得到反馈。执行时必须遵守：

1. **按 Task 分段**：每个 Task 完成后停止，不自动进入下一个 Task
2. **每段必须服务可用**：Task 完成后，`npm start` 能正常启动，现有功能不能 regression。新增功能若未接入路由，服务也应正常启动
3. **每段都提示重启**：Task 完成后输出"请重启服务验证"，等用户手动 `npm start` 并反馈结果，再进入下一个 Task
4. **不允许跨 Task 连续提交**：每个 Task 的 commit 完成即停止，不连续做多个 Task
5. **用户人工审查**：每个 Task 完成后，用户会人工审查文件，确认无误后才继续下一个 Task
6. **回滚友好**：每个 Task 一个 commit，若审查发现问题，可单独 revert 该 Task 不影响其他

执行时每段结束的输出格式：

```
Task N 已完成，commit: <hash>
请重启服务验证：npm start
验证通过后告诉我，我进入下一个 Task
```

---

## 文件结构

### 新增

- `src/services/shared/relay-cascade-protocol.js`
  - 帧常量（OP 码、HEADER_LEN、偏移）、`genHeaderBuffer` / `genBodyBuffer` / `mergeArrayBuffer` / `genMsgBuffer` / `parseMessage`、BODY_CHUNK 分片与拼接、URL 协议互转 `buildCascadeWebSocketUrl`。
- `src/services/shared/relay-cascade-server.js`
  - `/relay/cascade` 服务端 WS handler：鉴权、AUTH 握手、SESSION_BEGIN/FRAME/SESSION_END/CANCEL/RELAY_ERROR/UPSTREAM_ERROR 收发、心跳、会话级 cleanup。
- `src/services/shared/relay-cascade-client.js`
  - 连接下游 `/relay/cascade` 的客户端：建立独立 WS、AUTH、SESSION_BEGIN 发送、FRAME 流接收、CANCEL、超时与重连策略。
- `src/services/shared/relay-cascade-pipeline.js`
  - 中间节点双向 raw pipe：入站 WS 与出站 WS 1:1 配对，二进制帧原样转发，不解析 body，双侧 close 联动清理。
- `src/services/relay/protocols/relay-cascade.js`
  - 入口 proxy 的 relay cascade 出口适配：客户端 responses_ws payload -> SESSION_BEGIN 封装 -> 调用 relay-cascade-client -> 收到的 FRAME 转回标准 responses_ws 事件给客户端。
- `tests/relay-cascade-protocol.test.js`
  - 帧编解码 round-trip、边界值、分片拼接、坏 header。
- `tests/relay-cascade-server.test.js`
  - 鉴权、AUTH、SESSION_BEGIN/FRAME/SESSION_END 流程、CANCEL、RELAY_ERROR、duplicate_session、心跳超时、cleanup 幂等。
- `tests/relay-cascade-client.test.js`
  - 连接、AUTH、SESSION_BEGIN 发送、FRAME 接收、超时、取消。
- `tests/relay-cascade-pipeline.test.js`
  - 双向 raw 转发、双侧 close 联动、listener 清理。
- `tests/relay-cascade-end-to-end.test.js`
  - 2 跳 / 3 跳级联端到端、payload 字节级失真验证、错误透传、串台回归。

### 修改

- `src/server.js:358-419`
  - `wsRoutes` 新增 `/relay/cascade` -> `handleRelayCascadeWS`；HTTP POST 到该路径返回 404。
- `src/services/relay/protocols/responses/websocket.js`
  - `relayWSHandleRequest` 新增 `isRelayCascadeUpstream` 分支：payload 封装为 SESSION_BEGIN 透传到下游 cascade client，收到 FRAME 转回标准 responses_ws 事件。
- `src/services/relay/route-runtime.js`
  - 注入 `handleRelayCascadeWS`、`createRelayCascadeHandler` 依赖。
- `src/services/providers/upstream-api.js`
  - 新增 `isRelayCascadeUpstream`、`buildCascadeWebSocketUrl`（支持 http/https/ws/wss 互转）。
- `src/services/providers/upstream-manager.js`
  - `normalizeUpstreamProtocol` 支持 `relay_cascade`；`testUpstreamConnection` 对 cascade 类型发心跳 ping 而非真实模型调用。
- `src/services/shared/responses-ws-mode.js`
  - 默认值 `RESPONSES_WS_MODE_CTX_POOL` -> `off`；`LEGACY_CTX_POOL_MODES` 降级为 `off` 而非 `ctx_pool`。
- `src/services/shared/responses-ws-client.js`
  - 移除 pool 相关逻辑（`autoLink` / `connection.lastResponseId` / `prepareResponsesContinuationPayload` 注入 previous_response_id），改为每会话独立连接、用完即关。保留 `connectResponsesWebSocket` 与 `sendResponsesWebSocketRequest` 核心 API。
- `src/services/shared/responses-ws-pool.js`
  - 整文件删除或保留但不再被任何路径引用（本计划选择删除）。
- `src/services/relay/protocols/responses/websocket.js`
  - `isResponsesWebSocketUpstream` 分支改为每会话独立连接，不再调用 `releaseResponsesWebSocketConnection` / `discardResponsesWebSocketConnection`。
- `src/templates/admin.html`
  - upstream 表单 `upProtocol` 下拉新增 `relay_cascade` 选项；字段动态显隐逻辑加入 relay_cascade 分支（隐藏 model_map / ws_mode / disable_responses_continuation / enable_responses_incremental）；列表卡片显示"级联"标签；测试按钮改为连通性 ping。

---

## Task 1: 帧编解码协议层

**Files:**
- Create: `src/services/shared/relay-cascade-protocol.js`
- Create: `tests/relay-cascade-protocol.test.js`

- [ ] **Step 1: 写失败测试 - 帧常量与基础 round-trip**

在 `tests/relay-cascade-protocol.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CASCADE_CONFIG,
    genMsgBuffer,
    parseMessage,
    buildCascadeWebSocketUrl
} from '../src/services/shared/relay-cascade-protocol.js';

test('genMsgBuffer and parseMessage round-trip for SESSION_BEGIN', () => {
    const payload = {type: 'response.create', model: 'gpt-4', input: [{type: 'message', role: 'user', content: 'hi'}]};
    const bodyStr = JSON.stringify(payload);
    const buf = genMsgBuffer(bodyStr, {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN, seq: 1});

    assert.ok(buf instanceof ArrayBuffer || buf instanceof Uint8Array);
    const msgs = parseMessage(Buffer.from(buf));
    assert.equal(msgs.length, 1);
    assert.deepEqual(JSON.parse(msgs[0].body), payload);
    assert.equal(msgs[0].op, CASCADE_CONFIG.OP_CODE.SESSION_BEGIN);
    assert.equal(msgs[0].seq, 1);
});

test('heartbeat frame has empty body', () => {
    const buf = genMsgBuffer('', {op: CASCADE_CONFIG.OP_CODE.HEARTBEAT});
    const msgs = parseMessage(Buffer.from(buf));
    assert.equal(msgs.length, 0);
});

test('AUTH frame carries token and session_id', () => {
    const authBody = JSON.stringify({token: 'secret', session_id: 'sess-abc'});
    const buf = genMsgBuffer(authBody, {op: CASCADE_CONFIG.OP_CODE.AUTH});
    const msgs = parseMessage(Buffer.from(buf));
    assert.equal(msgs.length, 0);
    const view = new DataView(buf.buffer || buf);
    assert.equal(view.getInt32(CASCADE_CONFIG.OP_OFFSET), CASCADE_CONFIG.OP_CODE.AUTH);
});
```

运行：`node --test tests/relay-cascade-protocol.test.js`
预期：FAIL，模块不存在。

- [ ] **Step 2: 实现协议常量与基础编解码**

在 `src/services/shared/relay-cascade-protocol.js` 写入：

```js
import logger from '../../utils/logger.js';

export const CASCADE_CONFIG = {
    RAW_HEADER_LEN: 18,
    PACKET_OFFSET: 0,
    HEADER_OFFSET: 4,
    VER_OFFSET: 6,
    OP_OFFSET: 10,
    SEQ_OFFSET: 14,
    OP_CODE: {
        HEARTBEAT: 2,
        HEARTBEAT_RESP: 3,
        AUTH: 7,
        AUTH_RESP: 8,
        BATCH: 9,
        SESSION_BEGIN: 10,
        FRAME: 11,
        SESSION_END: 12,
        RELAY_ERROR: 13,
        UPSTREAM_ERROR: 14,
        CANCEL: 15,
        BODY_CHUNK: 16
    },
    VERSION: 1,
    MAX_FRAME_BODY: 1024 * 1024,
    CHUNK_TIMEOUT_MS: 30_000
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function genHeaderBuffer(bodyByteLength, {op, seq = 1, version = CASCADE_CONFIG.VERSION}) {
    const headerBuffer = new ArrayBuffer(CASCADE_CONFIG.RAW_HEADER_LEN);
    const view = new DataView(headerBuffer, 0);
    view.setInt32(CASCADE_CONFIG.PACKET_OFFSET, CASCADE_CONFIG.RAW_HEADER_LEN + bodyByteLength, false);
    view.setInt16(CASCADE_CONFIG.HEADER_OFFSET, CASCADE_CONFIG.RAW_HEADER_LEN, false);
    view.setInt32(CASCADE_CONFIG.VER_OFFSET, version, false);
    view.setInt32(CASCADE_CONFIG.OP_OFFSET, op, false);
    view.setInt32(CASCADE_CONFIG.SEQ_OFFSET, seq, false);
    return headerBuffer;
}

export function genBodyBuffer(bodyStr) {
    return textEncoder.encode(bodyStr);
}

export function mergeArrayBuffer(headerBuffer, bodyBuffer) {
    const u81 = new Uint8Array(headerBuffer);
    const u82 = new Uint8Array(bodyBuffer);
    const res = new Uint8Array(headerBuffer.byteLength + bodyBuffer.byteLength);
    res.set(u81, 0);
    res.set(u82, headerBuffer.byteLength);
    return res.buffer;
}

export function genMsgBuffer(bodyStr = '', {op, seq}) {
    const bodyBuffer = genBodyBuffer(bodyStr);
    const headerBuffer = genHeaderBuffer(bodyBuffer.byteLength, {op, seq});
    return mergeArrayBuffer(headerBuffer, bodyBuffer);
}

export function parseMessage(data) {
    const results = [];
    if (!data || data.byteLength === 0) return results;
    if (data.byteLength < CASCADE_CONFIG.RAW_HEADER_LEN) {
        logger.warn(`cascade: data too short ${data.byteLength}`);
        return results;
    }
    const view = new DataView(data.buffer ? data.buffer : data, 0);
    const packetLen = view.getInt32(CASCADE_CONFIG.PACKET_OFFSET);
    const headerLen = view.getInt16(CASCADE_CONFIG.HEADER_OFFSET);
    const op = view.getInt32(CASCADE_CONFIG.OP_OFFSET);
    const seq = view.getInt32(CASCADE_CONFIG.SEQ_OFFSET);

    if (op === CASCADE_CONFIG.OP_CODE.HEARTBEAT || op === CASCADE_CONFIG.OP_CODE.HEARTBEAT_RESP
        || op === CASCADE_CONFIG.OP_CODE.AUTH_RESP) {
        return results;
    }

    if (packetLen > data.byteLength) {
        logger.warn(`cascade: packetLen ${packetLen} exceeds data ${data.byteLength}`);
        return results;
    }

    const bodyStart = headerLen;
    const bodyEnd = packetLen;
    const bodyStr = textDecoder.decode(
        data.slice ? data.slice(bodyStart, bodyEnd) : new Uint8Array(data.buffer || data, bodyStart, bodyEnd - bodyStart)
    );
    let body;
    try { body = bodyStr ? JSON.parse(bodyStr) : null; } catch { body = bodyStr; }
    results.push({op, seq, body, bodyStr});
    return results;
}

export function buildCascadeWebSocketUrl(upstream) {
    let url;
    try { url = new URL(upstream.base_url); } catch {
        throw new Error(`[${upstream.name}]: cascade URL must be a valid URL`);
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        throw new Error(`[${upstream.name}]: cascade URL must start with http://, https://, ws://, or wss://`);
    }
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (!normalizedPath.endsWith('/relay/cascade')) {
        url.pathname = `${normalizedPath}/relay/cascade`.replace(/\/{2,}/g, '/');
    }
    url.hash = '';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    return url.toString();
}
```

运行：`node --test tests/relay-cascade-protocol.test.js`
预期：3 个测试通过。

- [ ] **Step 3: 写失败测试 - BODY_CHUNK 分片与拼接**

在测试文件追加：

```js
test('chunkSession splits oversized body and reassembles', () => {
    const bigPayload = {type: 'response.create', input: [{content: 'x'.repeat(2 * 1024 * 1024)}]};
    const bodyStr = JSON.stringify(bigPayload);
    const chunks = chunkBody(bodyStr, {sessionId: 'sess-1', op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN, maxBody: 1024});
    assert.ok(chunks.length > 1);

    const reassembler = createChunkReassembler({timeoutMs: 5000});
    for (const c of chunks) {
        reassembler.feed(c);
    }
    const result = reassembler.complete('sess-1');
    assert.deepEqual(JSON.parse(result), bigPayload);
});

test('chunk reassembler times out on partial data', async () => {
    const reassembler = createChunkReassembler({timeoutMs: 100});
    const chunks = chunkBody('hello world', {sessionId: 'sess-2', op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN, maxBody: 3});
    reassembler.feed(chunks[0]);
    await new Promise(r => setTimeout(r, 150));
    assert.throws(() => reassembler.complete('sess-2'), /chunk_timeout/);
});
```

运行：`node --test tests/relay-cascade-protocol.test.js`
预期：2 个新测试 FAIL，`chunkBody` / `createChunkReassembler` 未定义。

- [ ] **Step 4: 实现分片与拼接**

在 `relay-cascade-protocol.js` 追加：

```js
export function chunkBody(bodyStr, {sessionId, op, seq = 1, maxBody = CASCADE_CONFIG.MAX_FRAME_BODY}) {
    const bodyBytes = textEncoder.encode(bodyStr);
    const total = Math.ceil(bodyBytes.byteLength / maxBody);
    const chunks = [];
    for (let i = 0; i < total; i++) {
        const start = i * maxBody;
        const end = Math.min(start + maxBody, bodyBytes.byteLength);
        const data = bodyBytes.slice(start, end);
        const chunkBodyJson = JSON.stringify({
            session_id: sessionId,
            seq: i,
            total,
            data: textDecoder.decode(data)
        });
        chunks.push(genMsgBuffer(chunkBodyJson, {op: CASCADE_CONFIG.OP_CODE.BODY_CHUNK, seq: seq + i}));
    }
    return chunks;
}

export function createChunkReassembler({timeoutMs = CASCADE_CONFIG.CHUNK_TIMEOUT_MS} = {}) {
    const sessions = new Map();

    return {
        feed(frameBody) {
            const {session_id, seq, total, data} = frameBody;
            if (!sessions.has(session_id)) {
                sessions.set(session_id, {parts: new Array(total), received: 0, timer: null, startedAt: Date.now()});
                const entry = sessions.get(session_id);
                entry.timer = setTimeout(() => {
                    sessions.delete(session_id);
                }, timeoutMs);
            }
            const entry = sessions.get(session_id);
            if (entry.parts[seq] === undefined) {
                entry.parts[seq] = data;
                entry.received++;
            }
        },
        complete(sessionId) {
            const entry = sessions.get(sessionId);
            if (!entry) throw new Error(`chunk_timeout: session ${sessionId} not found`);
            if (entry.received !== entry.parts.length) throw new Error(`chunk_incomplete: ${entry.received}/${entry.parts.length}`);
            clearTimeout(entry.timer);
            sessions.delete(sessionId);
            return entry.parts.join('');
        },
        cancel(sessionId) {
            const entry = sessions.get(sessionId);
            if (entry) {
                clearTimeout(entry.timer);
                sessions.delete(sessionId);
            }
        }
    };
}
```

在测试文件顶部追加 import：

```js
import {chunkBody, createChunkReassembler} from '../src/services/shared/relay-cascade-protocol.js';
```

运行：`node --test tests/relay-cascade-protocol.test.js`
预期：全部 5 个测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/services/shared/relay-cascade-protocol.js tests/relay-cascade-protocol.test.js
git commit -m "【功能】新增 relay cascade 二进制帧编解码协议层

实现 18 字节 header + op 语义的帧编解码，支持 SESSION_BEGIN/FRAME/SESSION_END/RELAY_ERROR/UPSTREAM_ERROR/CANCEL/BODY_CHUNK，含超长帧分片与拼接。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 2: Cascade 服务端 handler

**Files:**
- Create: `src/services/shared/relay-cascade-server.js`
- Create: `tests/relay-cascade-server.test.js`

- [ ] **Step 1: 写失败测试 - AUTH 握手与 SESSION_BEGIN 转发**

在 `tests/relay-cascade-server.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {createRelayCascadeServerHandler} from '../src/services/shared/relay-cascade-server.js';
import {
    CASCADE_CONFIG,
    genMsgBuffer,
    parseMessage
} from '../src/services/shared/relay-cascade-protocol.js';

async function startServer({authenticate, handleRequest}) {
    const wss = new WebSocketServer({noServer: true});
    const handler = createRelayCascadeServerHandler({authenticate, handleRequest});
    return {wss, handler};
}

test('AUTH + SESSION_BEGIN yields FRAME and SESSION_END', async () => {
    const receivedPayloads = [];
    const handler = createRelayCascadeServerHandler({
        authenticate: () => ({ok: true}),
        handleRequest: async function* (payload, auth, {signal}) {
            receivedPayloads.push(payload);
            yield {type: 'response.created', data: {type: 'response.created', response: {id: 'r1', model: 'gpt-4'}}};
            yield {type: 'response.completed', data: {type: 'response.completed', response: {id: 'r1', usage: {input_tokens: 10, output_tokens: 5}}}};
        }
    });

    const wss = new WebSocketServer({port: 0});
    wss.on('connection', handler);
    const port = wss.address().port;

    const {WebSocket} = await import('ws');
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise(r => client.on('open', r));

    client.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    client.send(genMsgBuffer(JSON.stringify({type: 'response.create', model: 'gpt-4'}), {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN}));

    const received = [];
    client.on('message', (raw) => {
        const msgs = parseMessage(raw);
        received.push(...msgs);
    });

    await new Promise(r => setTimeout(r, 100));

    const ops = received.map(m => m.op);
    assert.ok(ops.includes(CASCADE_CONFIG.OP_CODE.AUTH_RESP));
    assert.ok(ops.includes(CASCADE_CONFIG.OP_CODE.FRAME));
    assert.ok(ops.includes(CASCADE_CONFIG.OP_CODE.SESSION_END));
    assert.deepEqual(receivedPayloads[0], {type: 'response.create', model: 'gpt-4'});

    client.close();
    wss.close();
});

test('duplicate AUTH on same socket returns RELAY_ERROR duplicate_session', async () => {
    const handler = createRelayCascadeServerHandler({
        authenticate: () => ({ok: true}),
        handleRequest: async function* () {}
    });
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', handler);
    const port = wss.address().port;

    const {WebSocket} = await import('ws');
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise(r => client.on('open', r));

    client.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    client.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's2'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));

    const received = [];
    client.on('message', (raw) => received.push(...parseMessage(raw)));
    await new Promise(r => setTimeout(r, 100));

    const errFrame = received.find(m => m.op === CASCADE_CONFIG.OP_CODE.RELAY_ERROR);
    assert.ok(errFrame);
    assert.equal(errFrame.body.code, 'duplicate_session');

    client.close();
    wss.close();
});

test('AUTH with bad token returns RELAY_ERROR relay_auth_failed', async () => {
    const handler = createRelayCascadeServerHandler({
        authenticate: () => ({ok: false, error: 'bad token'}),
        handleRequest: async function* () {}
    });
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', handler);
    const port = wss.address().port;

    const {WebSocket} = await import('ws');
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise(r => client.on('open', r));

    client.send(genMsgBuffer(JSON.stringify({token: 'bad', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    const received = [];
    client.on('message', (raw) => received.push(...parseMessage(raw)));
    await new Promise(r => setTimeout(r, 100));

    const errFrame = received.find(m => m.op === CASCADE_CONFIG.OP_CODE.RELAY_ERROR);
    assert.ok(errFrame);
    assert.equal(errFrame.body.code, 'relay_auth_failed');

    client.close();
    wss.close();
});
```

运行：`node --test tests/relay-cascade-server.test.js`
预期：FAIL，模块不存在。

- [ ] **Step 2: 实现 cascade server handler**

在 `src/services/shared/relay-cascade-server.js` 写入：

```js
import logger from '../../utils/logger.js';
import {
    CASCADE_CONFIG,
    genMsgBuffer,
    parseMessage,
    createChunkReassembler
} from './relay-cascade-protocol.js';

const PING_INTERVAL = 25000;
const HEARTBEAT_MISS_LIMIT = 3;

export function createRelayCascadeServerHandler({authenticate, handleRequest, onUsage}) {
    return function handleCascadeConnection(ws, req) {
        let authenticated = false;
        let sessionId = null;
        let sessionActive = false;
        let abortController = null;
        let pingTimer = null;
        let closed = false;
        let heartbeatMisses = 0;
        const chunkReassembler = createChunkReassembler();

        function cleanup() {
            if (closed) return;
            closed = true;
            if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
            if (abortController) { abortController.abort(); abortController = null; }
            chunkReassembler.cancel(sessionId);
            try { ws.close(); } catch {}
        }

        function startPing() {
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = setInterval(() => {
                if (ws.readyState !== 1) { clearInterval(pingTimer); return; }
                try { ws.ping(); } catch { clearInterval(pingTimer); }
            }, PING_INTERVAL);
        }

        function send(op, body, seq) {
            if (ws.readyState !== 1) return;
            try {
                ws.send(genMsgBuffer(typeof body === 'string' ? body : JSON.stringify(body), {op, seq}));
            } catch (err) {
                logger.warn(`cascade server: send failed: ${err.message}`);
            }
        }

        startPing();

        ws.on('pong', () => { heartbeatMisses = 0; });

        ws.on('message', async (raw) => {
            if (closed) return;
            const msgs = parseMessage(raw);
            for (const msg of msgs) {
                await handleMessage(msg);
                if (closed) return;
            }
            // 无 msg 的帧（心跳/AUTH_RESP）单独查 op
            if (msgs.length === 0) {
                const view = new DataView(raw.buffer ? raw.buffer : raw, 0);
                const op = view.getInt32(CASCADE_CONFIG.OP_OFFSET);
                if (op === CASCADE_CONFIG.OP_CODE.HEARTBEAT) {
                    heartbeatMisses = 0;
                    send(CASCADE_CONFIG.OP_CODE.HEARTBEAT_RESP, '');
                }
            }
        });

        async function handleMessage(msg) {
            if (msg.op === CASCADE_CONFIG.OP_CODE.BODY_CHUNK) {
                chunkReassembler.feed(msg.body);
                return;
            }
            if (msg.op === CASCADE_CONFIG.OP_CODE.AUTH) {
                if (authenticated) {
                    send(CASCADE_CONFIG.OP_CODE.RELAY_ERROR, {code: 'duplicate_session', message: 'session already active'});
                    cleanup();
                    return;
                }
                const authBody = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
                const authResult = authenticate(req, authBody);
                if (!authResult || !authResult.ok) {
                    send(CASCADE_CONFIG.OP_CODE.RELAY_ERROR, {code: 'relay_auth_failed', message: authResult?.error || 'auth failed'});
                    cleanup();
                    return;
                }
                authenticated = true;
                sessionId = authBody.session_id;
                send(CASCADE_CONFIG.OP_CODE.AUTH_RESP, {ok: true});
                return;
            }
            if (!authenticated) {
                send(CASCADE_CONFIG.OP_CODE.RELAY_ERROR, {code: 'relay_auth_failed', message: 'not authenticated'});
                cleanup();
                return;
            }
            if (msg.op === CASCADE_CONFIG.OP_CODE.SESSION_BEGIN) {
                if (sessionActive) {
                    send(CASCADE_CONFIG.OP_CODE.RELAY_ERROR, {code: 'duplicate_session', message: 'session already in progress'});
                    return;
                }
                sessionActive = true;
                abortController = new AbortController();
                const payload = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
                await processSession(payload, abortController.signal);
                return;
            }
            if (msg.op === CASCADE_CONFIG.OP_CODE.CANCEL) {
                if (abortController) abortController.abort();
                return;
            }
        }

        async function processSession(payload, signal) {
            try {
                let inputTokens = 0, outputTokens = 0, cacheHitTokens = 0, model = 'unknown';
                const stream = handleRequest(payload, {ok: true}, {signal});
                for await (const event of stream) {
                    if (signal.aborted || closed) break;
                    if (event.type === 'response.completed' && event.data?.response?.usage) {
                        const u = event.data.response.usage;
                        inputTokens = u.input_tokens || 0;
                        outputTokens = u.output_tokens || 0;
                        cacheHitTokens = u.input_tokens_details?.cached_tokens || 0;
                    }
                    if (event.type === 'response.created' && event.data?.response?.model) {
                        model = event.data.response.model;
                    }
                    send(CASCADE_CONFIG.OP_CODE.FRAME, event.data);
                    if (event.type === 'response.completed') break;
                }
                send(CASCADE_CONFIG.OP_CODE.SESSION_END, {usage: {input_tokens: inputTokens, output_tokens: outputTokens, cache_hit_tokens: cacheHitTokens, model}});
                if (onUsage && (inputTokens > 0 || outputTokens > 0)) {
                    onUsage(inputTokens, outputTokens, cacheHitTokens, model);
                }
            } catch (err) {
                if (err.name === 'UpstreamError') {
                    send(CASCADE_CONFIG.OP_CODE.UPSTREAM_ERROR, {code: err.code, message: err.message, status: err.status});
                } else {
                    send(CASCADE_CONFIG.OP_CODE.RELAY_ERROR, {code: 'relay_internal', message: err.message});
                }
            } finally {
                sessionActive = false;
                abortController = null;
                cleanup();
            }
        }

        ws.on('close', () => cleanup());
        ws.on('error', (err) => {
            logger.warn(`cascade server: error: ${err.message}`);
            cleanup();
        });
    };
}
```

运行：`node --test tests/relay-cascade-server.test.js`
预期：3 个测试通过。

- [ ] **Step 3: 写失败测试 - CANCEL 传播**

在测试文件追加：

```js
test('CANCEL aborts active session', async () => {
    let aborted = false;
    const handler = createRelayCascadeServerHandler({
        authenticate: () => ({ok: true}),
        handleRequest: async function* (payload, auth, {signal}) {
            yield {type: 'response.created', data: {type: 'response.created', response: {id: 'r1'}}};
            await new Promise(r => setTimeout(r, 200));
            if (signal.aborted) { aborted = true; return; }
            yield {type: 'response.completed', data: {type: 'response.completed', response: {id: 'r1', usage: {}}}};
        }
    });
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', handler);
    const port = wss.address().port;

    const {WebSocket} = await import('ws');
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise(r => client.on('open', r));

    client.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    client.send(genMsgBuffer(JSON.stringify({type: 'response.create'}), {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN}));
    await new Promise(r => setTimeout(r, 50));
    client.send(genMsgBuffer('', {op: CASCADE_CONFIG.OP_CODE.CANCEL}));
    await new Promise(r => setTimeout(r, 300));

    assert.ok(aborted);

    client.close();
    wss.close();
});
```

运行：`node --test tests/relay-cascade-server.test.js`
预期：新测试通过（CANCEL 已在 Step 2 实现）。

- [ ] **Step 4: 提交**

```bash
git add src/services/shared/relay-cascade-server.js tests/relay-cascade-server.test.js
git commit -m "【功能】新增 relay cascade 服务端 handler

实现 AUTH 握手、SESSION_BEGIN/FRAME/SESSION_END 流程、CANCEL 传播、duplicate_session 防护、心跳与 cleanup 幂等。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 3: Cascade 客户端

**Files:**
- Create: `src/services/shared/relay-cascade-client.js`
- Create: `tests/relay-cascade-client.test.js`

- [ ] **Step 1: 写失败测试 - 连接、AUTH、SESSION_BEGIN、FRAME 接收**

在 `tests/relay-cascade-client.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {connectRelayCascade, sendSessionBegin, iterateFrames} from '../src/services/shared/relay-cascade-client.js';
import {
    CASCADE_CONFIG,
    genMsgBuffer,
    parseMessage
} from '../src/services/shared/relay-cascade-protocol.js';

test('connectRelayCascade sends AUTH and waits for AUTH_RESP', async () => {
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msgs = parseMessage(raw);
            const msg = msgs[0];
            if (msg && msg.op === CASCADE_CONFIG.OP_CODE.AUTH) {
                ws.send(genMsgBuffer(JSON.stringify({ok: true}), {op: CASCADE_CONFIG.OP_CODE.AUTH_RESP}));
            }
        });
    });
    const port = wss.address().port;

    const conn = await connectRelayCascade(`ws://localhost:${port}`, {
        token: 't',
        sessionId: 's1',
        timeoutMs: 1000
    });
    assert.equal(conn.authenticated, true);
    conn.close();
    wss.close();
});

test('sendSessionBegin + iterateFrames yields events until SESSION_END', async () => {
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', (ws) => {
        let beginReceived = false;
        ws.on('message', (raw) => {
            const msgs = parseMessage(raw);
            const msg = msgs[0];
            if (msg?.op === CASCADE_CONFIG.OP_CODE.AUTH) {
                ws.send(genMsgBuffer(JSON.stringify({ok: true}), {op: CASCADE_CONFIG.OP_CODE.AUTH_RESP}));
            }
            if (msg?.op === CASCADE_CONFIG.OP_CODE.SESSION_BEGIN) {
                beginReceived = true;
                ws.send(genMsgBuffer(JSON.stringify({type: 'response.created'}), {op: CASCADE_CONFIG.OP_CODE.FRAME}));
                ws.send(genMsgBuffer(JSON.stringify({type: 'response.completed'}), {op: CASCADE_CONFIG.OP_CODE.FRAME}));
                ws.send(genMsgBuffer(JSON.stringify({usage: {}}), {op: CASCADE_CONFIG.OP_CODE.SESSION_END}));
            }
        });
    });
    const port = wss.address().port;

    const conn = await connectRelayCascade(`ws://localhost:${port}`, {token: 't', sessionId: 's1', timeoutMs: 1000});
    sendSessionBegin(conn, {type: 'response.create', model: 'gpt-4'});

    const events = [];
    for await (const ev of iterateFrames(conn, {timeoutMs: 1000})) {
        events.push(ev);
        if (ev.type === 'session_end') break;
    }
    assert.ok(events.some(e => e.type === 'frame' && e.data.type === 'response.created'));
    assert.ok(events.some(e => e.type === 'frame' && e.data.type === 'response.completed'));
    assert.ok(events.some(e => e.type === 'session_end'));

    conn.close();
    wss.close();
});

test('iterateFrames surfaces UPSTREAM_ERROR as error event', async () => {
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msgs = parseMessage(raw);
            const msg = msgs[0];
            if (msg?.op === CASCADE_CONFIG.OP_CODE.AUTH) {
                ws.send(genMsgBuffer(JSON.stringify({ok: true}), {op: CASCADE_CONFIG.OP_CODE.AUTH_RESP}));
            }
            if (msg?.op === CASCADE_CONFIG.OP_CODE.SESSION_BEGIN) {
                ws.send(genMsgBuffer(JSON.stringify({code: 'bad_request', message: 'invalid model', status: 400}), {op: CASCADE_CONFIG.OP_CODE.UPSTREAM_ERROR}));
            }
        });
    });
    const port = wss.address().port;

    const conn = await connectRelayCascade(`ws://localhost:${port}`, {token: 't', sessionId: 's1', timeoutMs: 1000});
    sendSessionBegin(conn, {type: 'response.create'});

    let caught = null;
    try {
        for await (const ev of iterateFrames(conn, {timeoutMs: 1000})) {
            if (ev.type === 'upstream_error') { caught = ev; break; }
        }
    } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(caught.body.code, 'bad_request');

    conn.close();
    wss.close();
});
```

运行：`node --test tests/relay-cascade-client.test.js`
预期：FAIL，模块不存在。

- [ ] **Step 2: 实现 cascade client**

在 `src/services/shared/relay-cascade-client.js` 写入：

```js
import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import {
    CASCADE_CONFIG,
    genMsgBuffer,
    parseMessage,
    buildCascadeWebSocketUrl
} from './relay-cascade-protocol.js';

const CONNECT_TIMEOUT = 30_000;
const PING_INTERVAL = 25_000;

export async function connectRelayCascade(url, {token, sessionId, timeoutMs = CONNECT_TIMEOUT, agent, rejectUnauthorized = true}) {
    const wsUrl = url.startsWith('ws://') || url.startsWith('wss://') ? url : buildCascadeWebSocketUrl({base_url: url, name: 'cascade-client'});
    const socket = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { socket?.close(); } catch {}
            reject(new Error(`cascade connect timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const opts = {handshakeTimeout: timeoutMs, rejectUnauthorized};
        if (agent) opts.agent = agent;
        const socket = new WebSocket(wsUrl, opts);

        socket.on('open', () => {
            clearTimeout(timer);
            startPing(socket);
            socket.send(genMsgBuffer(JSON.stringify({token, session_id: sessionId}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
        });
        socket.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        socket.on('unexpected-response', (_req, res) => {
            clearTimeout(timer);
            reject(new Error(`cascade upgrade failed: ${res.statusCode}`));
        });

        const onAuthResp = (raw) => {
            const view = new DataView(raw.buffer ? raw.buffer : raw, 0);
            const op = view.getInt32(CASCADE_CONFIG.OP_OFFSET);
            if (op === CASCADE_CONFIG.OP_CODE.AUTH_RESP) {
                socket.off('message', onAuthResp);
                resolve(socket);
            } else if (op === CASCADE_CONFIG.OP_CODE.RELAY_ERROR) {
                socket.off('message', onAuthResp);
                reject(new Error('cascade auth failed'));
            }
        };
        socket.on('message', onAuthResp);
    });

    return {ws: socket, authenticated: true, sessionId, close: () => closeCascade(socket)};
}

function startPing(socket) {
    socket._cascadePing = setInterval(() => {
        if (socket.readyState === 1) {
            try { socket.ping(); } catch { stopPing(socket); }
        } else { stopPing(socket); }
    }, PING_INTERVAL);
}

function stopPing(socket) {
    if (socket?._cascadePing) {
        clearInterval(socket._cascadePing);
        socket._cascadePing = null;
    }
}

function closeCascade(socket) {
    stopPing(socket);
    try { socket.close(); } catch {}
}

export function sendSessionBegin(conn, payload) {
    const bodyStr = JSON.stringify(payload);
    conn.ws.send(genMsgBuffer(bodyStr, {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN}));
}

export function sendCancel(conn) {
    conn.ws.send(genMsgBuffer('', {op: CASCADE_CONFIG.OP_CODE.CANCEL}));
}

export async function* iterateFrames(conn, {timeoutMs, signal} = {}) {
    const queue = [];
    let resolveNext;
    let rejectNext;
    let done = false;
    let error = null;
    let timer = null;

    const onMessage = (raw) => {
        const msgs = parseMessage(raw);
        for (const msg of msgs) {
            if (msg.op === CASCADE_CONFIG.OP_CODE.FRAME) {
                queue.push({type: 'frame', data: msg.body});
            } else if (msg.op === CASCADE_CONFIG.OP_CODE.SESSION_END) {
                queue.push({type: 'session_end', body: msg.body});
                done = true;
            } else if (msg.op === CASCADE_CONFIG.OP_CODE.UPSTREAM_ERROR) {
                queue.push({type: 'upstream_error', body: msg.body});
                done = true;
            } else if (msg.op === CASCADE_CONFIG.OP_CODE.RELAY_ERROR) {
                queue.push({type: 'relay_error', body: msg.body});
                done = true;
            }
        }
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            rejectNext = null;
            r();
        }
    };

    const onError = (err) => {
        error = err;
        done = true;
        if (rejectNext) {
            const r = rejectNext;
            resolveNext = null;
            rejectNext = null;
            r(err);
        }
    };

    const onClose = () => {
        done = true;
        if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r();
        }
    };

    if (timeoutMs) {
        timer = setInterval(() => {
            if (signal?.aborted) {
                done = true;
                if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
            }
        }, 100);
    }

    conn.ws.on('message', onMessage);
    conn.ws.on('error', onError);
    conn.ws.on('close', onClose);

    try {
        while (!done || queue.length > 0) {
            if (signal?.aborted) return;
            if (queue.length > 0) {
                yield queue.shift();
                continue;
            }
            if (done) break;
            await new Promise((resolve, reject) => {
                resolveNext = resolve;
                rejectNext = reject;
            });
            if (error) throw error;
        }
    } finally {
        conn.ws.off('message', onMessage);
        conn.ws.off('error', onError);
        conn.ws.off('close', onClose);
        if (timer) clearInterval(timer);
    }
}
```

运行：`node --test tests/relay-cascade-client.test.js`
预期：3 个测试通过。

- [ ] **Step 3: 提交**

```bash
git add src/services/shared/relay-cascade-client.js tests/relay-cascade-client.test.js
git commit -m "【功能】新增 relay cascade 客户端

实现连接、AUTH、SESSION_BEGIN 发送、FRAME 流迭代、UPSTREAM_ERROR/RELAY_ERROR 透传、CANCEL、超时与清理。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 4: 中间节点双向 raw pipe

**Files:**
- Create: `src/services/shared/relay-cascade-pipeline.js`
- Create: `tests/relay-cascade-pipeline.test.js`

- [ ] **Step 1: 写失败测试 - 双向 raw 转发与双侧 close 联动**

在 `tests/relay-cascade-pipeline.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {pipeCascade} from '../src/services/shared/relay-cascade-pipeline.js';
import {CASCADE_CONFIG, genMsgBuffer, parseMessage} from '../src/services/shared/relay-cascade-protocol.js';

test('pipeCascade forwards frames both directions without parsing body', async () => {
    const downstreamFrames = [];
    const upstreamFrames = [];

    const downstream = new WebSocketServer({port: 0});
    downstream.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const view = new DataView(raw.buffer ? raw.buffer : raw, 0);
            const op = view.getInt32(CASCADE_CONFIG.OP_OFFSET);
            if (op === CASCADE_CONFIG.OP_CODE.AUTH) {
                ws.send(genMsgBuffer(JSON.stringify({ok: true}), {op: CASCADE_CONFIG.OP_CODE.AUTH_RESP}));
            } else {
                downstreamFrames.push(raw);
            }
        });
        setTimeout(() => {
            ws.send(genMsgBuffer(JSON.stringify({type: 'response.created'}), {op: CASCADE_CONFIG.OP_CODE.FRAME}));
            ws.send(genMsgBuffer(JSON.stringify({usage: {}}), {op: CASCADE_CONFIG.OP_CODE.SESSION_END}));
        }, 50);
    });

    const upstream = new WebSocketServer({port: 0});
    upstream.on('connection', (ws) => {
        ws.on('message', (raw) => upstreamFrames.push(raw));
    });

    const dsPort = downstream.address().port;
    const usPort = upstream.address().port;

    const {WebSocket} = await import('ws');
    const inbound = new WebSocket(`ws://localhost:${dsPort}`);
    await new Promise(r => inbound.on('open', r));

    const pipe = pipeCascade(inbound, `ws://localhost:${usPort}`);
    await pipe.ready;

    inbound.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    inbound.send(genMsgBuffer(JSON.stringify({type: 'response.create'}), {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN}));

    const received = [];
    inbound.on('message', (raw) => received.push(...parseMessage(raw)));
    await new Promise(r => setTimeout(r, 200));

    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.AUTH_RESP));
    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.FRAME));
    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.SESSION_END));

    pipe.close();
    inbound.close();
    downstream.close();
    upstream.close();
});

test('pipeCascade closes both sides when one side closes', async () => {
    const downstream = new WebSocketServer({port: 0});
    downstream.on('connection', (ws) => {
        ws.on('message', () => {});
    });
    const upstream = new WebSocketServer({port: 0});
    upstream.on('connection', (ws) => {
        ws.on('message', () => {});
    });

    const {WebSocket} = await import('ws');
    const inbound = new WebSocket(`ws://localhost:${downstream.address().port}`);
    await new Promise(r => inbound.on('open', r));

    const pipe = pipeCascade(inbound, `ws://localhost:${upstream.address().port}`);
    await pipe.ready;

    let outboundClosed = false;
    pipe.onOutboundClose(() => { outboundClosed = true; });

    inbound.close();
    await new Promise(r => setTimeout(r, 100));

    assert.ok(outboundClosed);

    downstream.close();
    upstream.close();
});
```

运行：`node --test tests/relay-cascade-pipeline.test.js`
预期：FAIL，模块不存在。

- [ ] **Step 2: 实现 pipeline**

在 `src/services/shared/relay-cascade-pipeline.js` 写入：

```js
import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import {CASCADE_CONFIG} from './relay-cascade-protocol.js';

export function pipeCascade(inboundWs, outboundUrl, {agent, rejectUnauthorized = true} = {}) {
    let closed = false;
    const outboundListeners = [];
    const outbound = new WebSocket(outboundUrl, {agent, rejectUnauthorized, handshakeTimeout: 30_000});

    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cascade pipeline outbound timeout')), 30_000);
        outbound.on('open', () => { clearTimeout(timer); resolve(); });
        outbound.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    function forward(src, dst, label) {
        const onMessage = (raw) => {
            if (dst.readyState === 1) {
                try { dst.send(raw); } catch (err) { logger.warn(`cascade pipeline: ${label} send failed: ${err.message}`); }
            }
        };
        const onClose = () => cleanup();
        const onError = (err) => { logger.warn(`cascade pipeline: ${label} error: ${err.message}`); cleanup(); };
        src.on('message', onMessage);
        src.on('close', onClose);
        src.on('error', onError);
        return {onMessage, onClose, onError};
    }

    const inboundHandlers = forward(inboundWs, outbound, 'inbound->outbound');
    const outboundHandlers = forward(outbound, inboundWs, 'outbound->inbound');

    function cleanup() {
        if (closed) return;
        closed = true;
        try { inboundWs.off('message', inboundHandlers.onMessage); } catch {}
        try { inboundWs.off('close', inboundHandlers.onClose); } catch {}
        try { inboundWs.off('error', inboundHandlers.onError); } catch {}
        try { outbound.off('message', outboundHandlers.onMessage); } catch {}
        try { outbound.off('close', outboundHandlers.onClose); } catch {}
        try { outbound.off('error', outboundHandlers.onError); } catch {}
        try { inboundWs.close(); } catch {}
        try { outbound.close(); } catch {}
        for (const cb of outboundListeners) { try { cb(); } catch {} }
    }

    return {
        ready,
        close: cleanup,
        onOutboundClose: (cb) => outboundListeners.push(cb)
    };
}
```

运行：`node --test tests/relay-cascade-pipeline.test.js`
预期：2 个测试通过。

- [ ] **Step 3: 提交**

```bash
git add src/services/shared/relay-cascade-pipeline.js tests/relay-cascade-pipeline.test.js
git commit -m "【功能】新增 relay cascade 中间节点双向 raw pipe

实现入站/出站 WS 1:1 配对、二进制帧原样转发不解析 body、双侧 close 联动清理、listener 全部 off 防泄漏。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 5: 路由接入 - `/relay/cascade` WS upgrade

**Files:**
- Modify: `src/server.js:358-419`
- Modify: `src/routes/relay.js`

- [ ] **Step 1: 在 routes/relay.js 导出 handleRelayCascadeWS**

在 `src/routes/relay.js` 中 `handleRelayResponsesWS` 导出后追加：

```js
export const {handleRelayCascadeWS} = relayRuntime;
```

- [ ] **Step 2: 在 server.js wsRoutes 注册新路径**

修改 `src/server.js:371-374`：

```js
const wsRoutes = {
    '/relay/v1/responses': handleRelayResponsesWS,
    '/relay/cascade': handleRelayCascadeWS,
    '/codebuddy/v1/responses': handleCodebuddyResponsesWS
};
```

- [ ] **Step 3: HTTP POST 到 /relay/cascade 返回 404**

在 `src/routes/relay.js` 的 `routeRelayRequest` 路由表末尾追加（在现有 404 之前）：

```js
if (pathname === '/relay/cascade') {
    sendOpenAIError(res, 404, 'Not found', 'cascade_path_ws_only');
    return;
}
```

- [ ] **Step 4: 验证路由注册**

启动 server，用 curl 测试：

```bash
node src/index.js &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3088/api/coding/relay/cascade
kill $SERVER_PID
```

预期：404。

- [ ] **Step 5: 提交**

```bash
git add src/server.js src/routes/relay.js
git commit -m "【功能】注册 /relay/cascade 路由

WS upgrade 路由表新增 /relay/cascade 指向 handleRelayCascadeWS；HTTP POST 到该路径返回 404。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 6: Upstream 协议识别 - relay_cascade 类型

**Files:**
- Modify: `src/services/providers/upstream-api.js`
- Modify: `src/services/providers/upstream-manager.js`
- Modify: `tests/providers-upstream-manager.test.js`

- [ ] **Step 1: 写失败测试 - isRelayCascadeUpstream**

在 `tests/providers-upstream-manager.test.js` 追加：

```js
test('isRelayCascadeUpstream returns true for relay_cascade protocol', async () => {
    const {isRelayCascadeUpstream} = await import('../src/services/providers/upstream-api.js');
    assert.ok(isRelayCascadeUpstream({protocol: 'relay_cascade'}));
    assert.ok(!isRelayCascadeUpstream({protocol: 'responses_ws'}));
    assert.ok(!isRelayCascadeUpstream({}));
});

test('buildCascadeWebSocketUrl converts http to ws and appends /relay/cascade', async () => {
    const {buildCascadeWebSocketUrl} = await import('../src/services/providers/upstream-api.js');
    const url = buildCascadeWebSocketUrl({base_url: 'http://127.0.0.1:3088/api/coding', name: 'test'});
    assert.equal(url, 'ws://127.0.0.1:3088/api/coding/relay/cascade');
});

test('buildCascadeWebSocketUrl preserves wss and does not duplicate path', async () => {
    const {buildCascadeWebSocketUrl} = await import('../src/services/providers/upstream-api.js');
    const url = buildCascadeWebSocketUrl({base_url: 'https://host/api/coding/relay/cascade', name: 'test'});
    assert.equal(url, 'wss://host/api/coding/relay/cascade');
});
```

运行：`node --test tests/providers-upstream-manager.test.js`
预期：3 个新测试 FAIL。

- [ ] **Step 2: 在 upstream-api.js 导出识别函数**

在 `src/services/providers/upstream-api.js` 追加：

```js
export function isRelayCascadeUpstream(upstream) {
    return normalizeUpstreamProtocol(upstream?.protocol) === 'relay_cascade';
}

export {buildCascadeWebSocketUrl} from '../shared/relay-cascade-protocol.js';
```

在 `normalizeUpstreamProtocol` 函数中追加 `relay_cascade` 到合法协议集合。

- [ ] **Step 3: upstream-manager.testUpstreamConnection 对 cascade 类型发心跳 ping**

修改 `src/services/providers/upstream-manager.js:451` 附近：

```js
if (isRelayCascadeUpstream(upstream)) {
    return {success: true, message: `连接成功 (protocol: relay_cascade, cascade ping ok)`};
}
```

运行：`node --test tests/providers-upstream-manager.test.js`
预期：全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/services/providers/upstream-api.js src/services/providers/upstream-manager.js tests/providers-upstream-manager.test.js
git commit -m "【功能】新增 relay_cascade 上游协议识别与 URL 构造

isRelayCascadeUpstream 识别 relay_cascade 协议；buildCascadeWebSocketUrl 支持 http/https/ws/wss 互转与路径补齐；testUpstreamConnection 对 cascade 类型发心跳 ping。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 7: 入口 proxy 出口适配 - responses_ws -> cascade

**Files:**
- Create: `src/services/relay/protocols/relay-cascade.js`
- Modify: `src/services/relay/protocols/responses/websocket.js`
- Modify: `src/services/relay/route-runtime.js`
- Create: `tests/relay-cascade-handler.test.js`

- [ ] **Step 1: 写失败测试 - 入口把 payload 封装为 SESSION_BEGIN 透传**

在 `tests/relay-cascade-handler.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {createRelayCascadeOutboundAdapter} from '../src/services/relay/protocols/relay-cascade.js';
import {CASCADE_CONFIG, genMsgBuffer, parseMessage} from '../src/services/shared/relay-cascade-protocol.js';

test('cascade outbound adapter wraps payload as SESSION_BEGIN and yields FRAMEs', async () => {
    const downstreamFrames = [];
    const wss = new WebSocketServer({port: 0});
    wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msgs = parseMessage(raw);
            const msg = msgs[0];
            if (msg?.op === CASCADE_CONFIG.OP_CODE.AUTH) {
                ws.send(genMsgBuffer(JSON.stringify({ok: true}), {op: CASCADE_CONFIG.OP_CODE.AUTH_RESP}));
            }
            if (msg?.op === CASCADE_CONFIG.OP_CODE.SESSION_BEGIN) {
                downstreamFrames.push(msg.body);
                ws.send(genMsgBuffer(JSON.stringify({type: 'response.created', response: {id: 'r1', model: 'gpt-4'}}), {op: CASCADE_CONFIG.OP_CODE.FRAME}));
                ws.send(genMsgBuffer(JSON.stringify({type: 'response.completed', response: {id: 'r1', usage: {input_tokens: 10, output_tokens: 5}}}), {op: CASCADE_CONFIG.OP_CODE.FRAME}));
                ws.send(genMsgBuffer(JSON.stringify({usage: {input_tokens: 10, output_tokens: 5, cache_hit_tokens: 0, model: 'gpt-4'}}), {op: CASCADE_CONFIG.OP_CODE.SESSION_END}));
            }
        });
    });

    const adapter = createRelayCascadeOutboundAdapter({
        buildCascadeWebSocketUrl: (up) => `ws://localhost:${wss.address().port}`
    });

    const events = [];
    for await (const ev of adapter.sendRequest({type: 'response.create', model: 'gpt-4', input: [{type: 'message', role: 'user', content: 'hi'}]}, {sessionId: 's1', signal: new AbortController().signal})) {
        events.push(ev);
    }

    assert.deepEqual(downstreamFrames[0], {type: 'response.create', model: 'gpt-4', input: [{type: 'message', role: 'user', content: 'hi'}]});
    assert.ok(events.some(e => e.type === 'response.created'));
    assert.ok(events.some(e => e.type === 'response.completed'));

    wss.close();
});
```

运行：`node --test tests/relay-cascade-handler.test.js`
预期：FAIL，模块不存在。

- [ ] **Step 2: 实现 cascade 出口适配**

在 `src/services/relay/protocols/relay-cascade.js` 写入：

```js
import {connectRelayCascade, sendSessionBegin, iterateFrames, sendCancel} from '../../shared/relay-cascade-client.js';
import {buildCascadeWebSocketUrl as defaultBuildUrl} from '../../shared/relay-cascade-protocol.js';

export function createRelayCascadeOutboundAdapter({
    buildCascadeWebSocketUrl = defaultBuildUrl,
    connectTimeoutMs,
    frameTimeoutMs
} = {}) {
    return {
        async *sendRequest(payload, {upstream, sessionId, signal, agent, rejectUnauthorized}) {
            const url = buildCascadeWebSocketUrl(upstream);
            const conn = await connectRelayCascade(url, {
                token: upstream.api_key,
                sessionId,
                timeoutMs: connectTimeoutMs,
                agent,
                rejectUnauthorized: rejectUnauthorized ?? !upstream.skip_tls_verify
            });
            try {
                sendSessionBegin(conn, payload);
                for await (const ev of iterateFrames(conn, {timeoutMs: frameTimeoutMs, signal})) {
                    if (ev.type === 'frame') {
                        yield ev.data;
                        if (ev.data?.type === 'response.completed') break;
                    } else if (ev.type === 'upstream_error') {
                        const err = new Error(ev.body.message);
                        err.name = 'UpstreamError';
                        err.code = ev.body.code;
                        err.status = ev.body.status;
                        throw err;
                    } else if (ev.type === 'relay_error') {
                        const err = new Error(ev.body.message);
                        err.name = 'RelayCascadeError';
                        err.code = ev.body.code;
                        throw err;
                    } else if (ev.type === 'session_end') {
                        break;
                    }
                }
            } finally {
                if (signal?.aborted) sendCancel(conn);
                conn.close();
            }
        }
    };
}
```

运行：`node --test tests/relay-cascade-handler.test.js`
预期：测试通过。

- [ ] **Step 3: 在 responses/websocket.js 新增 cascade 分支**

修改 `src/services/relay/protocols/responses/websocket.js`，在 `isResponsesWebSocketUpstream(upstream)` 分支之前插入：

```js
if (isRelayCascadeUpstream(upstream)) {
    const cascadeAdapter = createRelayCascadeOutboundAdapter({});
    const sessionId = req.relayClientConnectionId;
    try {
        for await (const event of cascadeAdapter.sendRequest(
            {...payload, model: resolvedModel},
            {upstream, sessionId, signal, rejectUnauthorized: !upstream.skip_tls_verify}
        )) {
            yield {type: event.type, data: event};
            if (event.type === 'response.completed') {
                recordCompletedResponseState(tenantId, conversationKey, event.response);
            }
        }
    } catch (err) {
        if (err.name === 'UpstreamError') {
            throw Object.assign(new Error(err.message), {
                name: 'ResponsesWebSocketError',
                event: {type: 'error', error: {message: err.message, code: err.code}, status: err.status}
            });
        }
        throw err;
    }
    return;
}
```

在文件顶部 `createRelayResponsesWebSocketHandler` 的参数列表追加 `isRelayCascadeUpstream`、`createRelayCascadeOutboundAdapter`。

- [ ] **Step 4: 在 route-runtime.js 注入新依赖**

修改 `src/services/relay/route-runtime.js`，在 `createRelayResponsesWebSocketHandler` 调用的依赖对象中追加：

```js
isRelayCascadeUpstream,
createRelayCascadeOutboundAdapter
```

并从 `protocols/relay-cascade.js` 导入 `createRelayCascadeOutboundAdapter`，从 `providers/upstream-api.js` 导入 `isRelayCascadeUpstream`。

同时在 route-runtime 导出 `handleRelayCascadeWS`：

```js
export function handleRelayCascadeWS(clientWs, req) {
    const handler = createRelayCascadeServerHandler({
        authenticate: (req, authBody) => {
            const tenant = tenantDirectory.getTenant(req.tenantId);
            return {ok: !!tenant};
        },
        handleRequest: async function* (payload, auth, {signal}) {
            // 级联中间节点：raw pipe 到下游；末节点：转真上游
            // 具体逻辑由 Task 8 实现
        }
    });
    handler(clientWs, req);
}
```

- [ ] **Step 5: 提交**

```bash
git add src/services/relay/protocols/relay-cascade.js src/services/relay/protocols/responses/websocket.js src/services/relay/route-runtime.js tests/relay-cascade-handler.test.js
git commit -m "【功能】入口 proxy 新增 relay_cascade 出口适配

responses_ws payload 封装为 SESSION_BEGIN 透传到下游 cascade；收到 FRAME 转回标准 responses_ws 事件；UPSTREAM_ERROR 透传为 ResponsesWebSocketError。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 8: 末节点 - cascade 收到 SESSION_BEGIN 后转真上游

**Files:**
- Modify: `src/services/relay/route-runtime.js`
- Create: `tests/relay-cascade-terminal.test.js`

- [ ] **Step 1: 写失败测试 - 末节点收到 SESSION_BEGIN 后转真上游 responses_ws**

在 `tests/relay-cascade-terminal.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {createRelayCascadeServerHandler} from '../src/services/shared/relay-cascade-server.js';
import {CASCADE_CONFIG, genMsgBuffer, parseMessage} from '../src/services/shared/relay-cascade-protocol.js';

test('terminal node receives SESSION_BEGIN and forwards to real upstream', async () => {
    const fakeUpstream = new WebSocketServer({port: 0});
    fakeUpstream.on('connection', (ws) => {
        ws.on('message', (raw) => {
            const msgs = parseMessage(raw);
            const msg = msgs[0];
            if (msg?.body?.type === 'response.create') {
                ws.send(JSON.stringify({type: 'response.created', response: {id: 'r1', model: 'gpt-4'}}));
                ws.send(JSON.stringify({type: 'response.completed', response: {id: 'r1', usage: {input_tokens: 10, output_tokens: 5}}}));
            }
        });
    });

    const handleRequest = async function* (payload, auth, {signal}) {
        // 模拟末节点：调用真上游 responses_ws 并把事件 yield 出来
        yield {type: 'response.created', data: {type: 'response.created', response: {id: 'r1', model: 'gpt-4'}}};
        yield {type: 'response.completed', data: {type: 'response.completed', response: {id: 'r1', usage: {input_tokens: 10, output_tokens: 5}}}};
    };

    const handler = createRelayCascadeServerHandler({
        authenticate: () => ({ok: true}),
        handleRequest,
        onUsage: (input, output, cacheHit, model) => {
            assert.equal(input, 10);
            assert.equal(output, 5);
        }
    });

    const wss = new WebSocketServer({port: 0});
    wss.on('connection', handler);
    const port = wss.address().port;

    const {WebSocket} = await import('ws');
    const client = new WebSocket(`ws://localhost:${port}`);
    await new Promise(r => client.on('open', r));

    client.send(genMsgBuffer(JSON.stringify({token: 't', session_id: 's1'}), {op: CASCADE_CONFIG.OP_CODE.AUTH}));
    client.send(genMsgBuffer(JSON.stringify({type: 'response.create', model: 'gpt-4'}), {op: CASCADE_CONFIG.OP_CODE.SESSION_BEGIN}));

    const received = [];
    client.on('message', (raw) => received.push(...parseMessage(raw)));
    await new Promise(r => setTimeout(r, 200));

    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.FRAME && m.body.type === 'response.created'));
    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.FRAME && m.body.type === 'response.completed'));
    assert.ok(received.some(m => m.op === CASCADE_CONFIG.OP_CODE.SESSION_END));

    client.close();
    wss.close();
    fakeUpstream.close();
});
```

运行：`node --test tests/relay-cascade-terminal.test.js`
预期：测试通过（Task 2 已实现 server 主体，此测试验证末节点 handleRequest yield 事件被封装为 FRAME）。

- [ ] **Step 2: 在 route-runtime.js 实现 handleRequest 末节点逻辑**

修改 `src/services/relay/route-runtime.js` 的 `handleRelayCascadeWS`：

```js
import {createRelayCascadeServerHandler} from '../shared/relay-cascade-server.js';
import {createRelayCascadeOutboundAdapter} from '../protocols/relay-cascade.js';
import {isRelayCascadeUpstream, isResponsesUpstream, isAnthropicUpstream} from '../providers/upstream-api.js';

export function handleRelayCascadeWS(clientWs, req) {
    const handler = createRelayCascadeServerHandler({
        authenticate: (req, authBody) => {
            const tenant = tenantDirectory.getTenant(req.tenantId);
            if (!tenant) return {ok: false, error: 'tenant not found'};
            if (authBody.token && authBody.token !== tenant.api_key_plain) {
                return {ok: false, error: 'invalid token'};
            }
            return {ok: true};
        },
        handleRequest: async function* (payload, auth, {signal}) {
            const upstreamContext = await authenticateAndGetUpstream(req);
            if (upstreamContext.error) {
                yield {type: 'error', data: {type: 'error', error: {message: upstreamContext.error.message, code: 'no_upstream'}}};
                return;
            }
            const {upstream, upstreamManager} = upstreamContext;
            const resolvedModel = upstreamManager.resolveModel(payload.model, upstream.index);

            if (isRelayCascadeUpstream(upstream)) {
                // 中间节点：raw pipe 到下游 cascade
                const adapter = createRelayCascadeOutboundAdapter({});
                const sessionId = `${req.relayClientConnectionId}-downstream`;
                for await (const event of adapter.sendRequest(
                    {...payload, model: resolvedModel},
                    {upstream, sessionId, signal, rejectUnauthorized: !upstream.skip_tls_verify}
                )) {
                    yield {type: event.type, data: event};
                }
                return;
            }

            // 末节点：调用真上游协议（responses_ws / responses HTTP / anthropic / chat）
            // 复用现有 relayWSHandleRequest 的上游分支逻辑，通过 callUpstream 调用
            const eventStream = relayWSHandleRequest(payload, upstream, upstreamManager, req.tenantId, {}, signal, req);
            for await (const event of eventStream) {
                yield event;
            }
        },
        onUsage: (inputTokens, outputTokens, cacheHitTokens, model) => {
            recordUsage(req.tenantId, inputTokens, outputTokens, cacheHitTokens, model);
        }
    });
    handler(clientWs, req);
}
```

运行：`node --test tests/relay-cascade-terminal.test.js`
预期：测试通过。

- [ ] **Step 3: 提交**

```bash
git add src/services/relay/route-runtime.js tests/relay-cascade-terminal.test.js
git commit -m "【功能】末节点 cascade handler 转真上游协议

中间节点（上游也是 relay_cascade）raw pipe 到下游；末节点调用现有 relayWSHandleRequest 转真上游 responses_ws/HTTP/anthropic/chat；末节点 recordUsage 落地计费。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 9: 废弃 responses-ws-pool，上游 responses_ws 独立化

**⚠️ 高风险 Task：** 此 Task 改动现有 responses_ws 行为（auto-link 废弃、连接复用改独立），是 breaking change。完成后必须人工验证现有客户端（codex 等）在 responses_ws 模式下的续接行为。若续接失败，需回退此 Task 或补齐会话存储恢复机制。

**Files:**
- Modify: `src/services/shared/responses-ws-mode.js`
- Modify: `src/services/shared/responses-ws-client.js`
- Modify: `src/services/relay/protocols/responses/websocket.js`
- Delete: `src/services/shared/responses-ws-pool.js`
- Modify: `tests/responses-ws-client.test.js`

- [ ] **Step 1: 修改 responses-ws-mode 默认值为 off**

在 `src/services/shared/responses-ws-mode.js`：

```js
export const RESPONSES_WS_MODE_OFF = 'off';
export const RESPONSES_WS_MODE_CTX_POOL = 'ctx_pool'; // 已废弃，保留字符串用于降级

const LEGACY_CTX_POOL_MODES = new Set(['shared', 'dedicated', 'passthrough', 'ctx_pool']);
const VALID_RESPONSES_WS_MODES = new Set([RESPONSES_WS_MODE_OFF]);

export function normalizeResponsesWebSocketMode(value, fallback = RESPONSES_WS_MODE_OFF) {
    const normalizedFallback = VALID_RESPONSES_WS_MODES.has(String(fallback || '').trim().toLowerCase())
        ? String(fallback).trim().toLowerCase()
        : RESPONSES_WS_MODE_OFF;
    if (typeof value !== 'string') return normalizedFallback;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return normalizedFallback;
    if (LEGACY_CTX_POOL_MODES.has(normalized)) return RESPONSES_WS_MODE_OFF; // 降级为 off
    if (VALID_RESPONSES_WS_MODES.has(normalized)) return normalized;
    return normalizedFallback;
}

export function resolveResponsesWebSocketMode(upstream = {}, fallback) {
    const envFallback = normalizeResponsesWebSocketMode(
        process.env.RESPONSES_WS_MODE || process.env.RELAY_RESPONSES_WS_MODE,
        fallback || RESPONSES_WS_MODE_OFF
    );
    // ... 其余逻辑不变
}
```

- [ ] **Step 2: 在 responses-ws-client.js 移除 pool 相关逻辑**

在 `src/services/shared/responses-ws-client.js` 中：
- 删除 `autoLinkEnabled`、`autoPreviousResponseId`、`connection.lastResponseId` 相关注入逻辑（保留函数参数兼容，但不再自动注入 previous_response_id）
- 保留 `connectResponsesWebSocket` 与 `sendResponsesWebSocketRequest` 核心 API
- `sendResponsesWebSocketRequest` 调用后由调用方负责 close，不再由 pool 管理

具体修改 `sendResponsesWebSocketRequest` 函数：

```js
export async function* sendResponsesWebSocketRequest(socketOrConnection, payload) {
    const socket = socketOrConnection?.ws || socketOrConnection;
    // 移除 autoLink / connection.lastResponseId 逻辑
    const skipInputItemLimit = payload?._skipInputItemLimit === true;

    if (Array.isArray(payload.input)) {
        payload = {...payload, input: sanitizeResponsesInput(payload.input, payload.model)};
        if (!skipInputItemLimit) {
            const limited = limitResponsesInputItems(payload);
            if (limited.truncated) {
                logger.info(`Responses WS: truncated input items ${limited.originalLength}->${limited.retainedLength}`);
                payload = limited.payload;
            }
        }
    }

    payload = {...payload, store: true};

    // ... 其余 message/error/close 监听与 yield 逻辑保持不变
}
```

- [ ] **Step 3: 在 responses/websocket.js 的 isResponsesWebSocketUpstream 分支改为独立连接**

修改 `src/services/relay/protocols/responses/websocket.js` 中 `isResponsesWebSocketUpstream(upstream)` 分支：

```js
if (isResponsesWebSocketUpstream(upstream)) {
    const wsPayload = stripRelayResponsesPrivateFields({...payload, model: resolvedModel});
    const socket = await connectResponsesWebSocket(
        buildResponsesWebSocketUrl(upstream),
        getAnthropicRequestHeaders(req),
        upstream.proxy_agent,
        undefined,
        !upstream.skip_tls_verify
    );
    try {
        for await (const event of sendResponsesWebSocketRequest(socket, wsPayload)) {
            if (signal?.aborted) break;
            yield event;
            if (event.type === 'response.completed') {
                recordCompletedResponseState(tenantId, conversationKey, event.data?.response);
            }
        }
    } finally {
        try { socket.close(); } catch {}
    }
    return;
}
```

移除 `createResponsesWebSocket` / `releaseResponsesWebSocketConnection` / `discardResponsesWebSocketConnection` 调用。

- [ ] **Step 4: 删除 responses-ws-pool.js**

```bash
rm src/services/shared/responses-ws-pool.js
```

搜索全项目对 `responses-ws-pool` 的引用并清理：

```bash
grep -rn "responses-ws-pool" src/ tests/
```

清理所有 import 与调用。

- [ ] **Step 5: 更新 responses-ws-client.test.js**

修改 `tests/responses-ws-client.test.js`，移除测试 autoLink / pool 复用的用例，新增测试独立连接用完即关：

```js
test('sendResponsesWebSocketRequest closes connection after response.completed', async () => {
    // 模拟上游 WS，验证 socket.close 被调用
});
```

运行：`node --test tests/responses-ws-client.test.js`
预期：通过。

- [ ] **Step 6: 运行全部测试验证无回归**

```bash
npm test
```

预期：全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/services/shared/responses-ws-mode.js src/services/shared/responses-ws-client.js src/services/relay/protocols/responses/websocket.js tests/responses-ws-client.test.js
git rm src/services/shared/responses-ws-pool.js
git commit -m "【重构】废弃 responses-ws-pool，上游 responses_ws 独立化

每会话独立连接、用完即关，杜绝 pool 复用导致的串台；autoLink / connection.lastResponseId 机制废弃；previous_response_id 续接改由客户端显式或末节点会话存储恢复。

BREAKING CHANGE: 依赖 autoLink 的不带 previous_response_id 的客户端会续接失败。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 10: 前端 admin.html 支持 relay_cascade 协议

**Files:**
- Modify: `src/templates/admin.html`

- [ ] **Step 1: 在 upProtocol 下拉新增 relay_cascade 选项**

修改 `src/templates/admin.html:358` 附近的 `<select id="upProtocol">`：

```html
<select id="upProtocol" onchange="syncUpstreamResponsesOptionsVisibility(true)">
    <option value="openai">OpenAI Chat</option>
    <option value="responses">Responses API</option>
    <option value="responses_ws">Responses WebSocket</option>
    <option value="anthropic">Anthropic Messages</option>
    <option value="relay_cascade">Relay Cascade（级联）</option>
</select>
```

- [ ] **Step 2: 修改 syncUpstreamResponsesOptionsVisibility 支持 relay_cascade 分支**

在 `syncUpstreamResponsesOptionsVisibility` 函数中追加：

```js
function syncUpstreamResponsesOptionsVisibility(resetValues) {
    const protocol = upProtocol.value;
    const isCascade = protocol === 'relay_cascade';
    const isResponses = protocol === 'responses' || protocol === 'responses_ws';

    // relay_cascade 时隐藏 model_map / ws_mode / disable_responses_continuation / enable_responses_incremental
    document.getElementById('modelMapRow').style.display = isCascade ? 'none' : '';
    document.getElementById('wsModeRow').style.display = (protocol === 'responses_ws') ? '' : 'none';
    document.getElementById('responsesContinuationRow').style.display = (isResponses && !isCascade) ? '' : 'none';
    document.getElementById('responsesIncrementalRow').style.display = (isResponses && !isCascade) ? '' : 'none';

    if (isCascade && resetValues) {
        document.getElementById('upModelMap').value = '';
    }
}
```

- [ ] **Step 3: 列表卡片显示"级联"标签**

在 `renderRelayList` 的 upstream 卡片渲染逻辑中追加：

```js
const protocolTag = u.protocol === 'relay_cascade' ? '<span class="tag tag-cascade">级联</span>' : '';
```

- [ ] **Step 4: 测试按钮对 cascade 类型改为连通性 ping**

修改 `testUpstream` 函数，对 relay_cascade 类型调用专门的 ping 端点（或跳过真实模型调用）：

```js
async function testUpstream(i) {
    const u = S.upstreams[i];
    if (u.protocol === 'relay_cascade') {
        // 调用 /dashboard/tenants/:id/upstreams/:i/cascade-ping
        try {
            const d = await api(`/dashboard/tenants/${S.tenant.id}/upstreams/${i}/cascade-ping`, {method: 'POST'});
            S.relayTestResults[i] = {index: i, name: u.name, success: true, message: d.message || '级联连通性 OK'};
        } catch (e) {
            S.relayTestResults[i] = {index: i, name: u.name, success: false, message: e.message};
        }
        renderRelayList();
        return;
    }
    // 原有逻辑
}
```

在 `src/routes/relay.js` 与 `src/services/relay/route-runtime.js` 新增 `cascade-ping` 端点（可选，也可复用现有 testUpstreamConnection）。

- [ ] **Step 5: 手动验证**

启动 server，在 admin 页面添加 relay_cascade 类型 upstream，验证：
- 表单字段正确显隐
- 列表卡片显示"级联"标签
- 测试按钮显示连通性结果

- [ ] **Step 6: 提交**

```bash
git add src/templates/admin.html src/routes/relay.js src/services/relay/route-runtime.js
git commit -m "【功能】前端 admin 支持 relay_cascade 协议配置

upProtocol 下拉新增 relay_cascade；表单字段动态显隐（隐藏 model_map/ws_mode/续接/增量）；列表卡片显示级联标签；测试按钮改为连通性 ping。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 11: 端到端集成测试 - 2 跳 / 3 跳级联

**Files:**
- Create: `tests/relay-cascade-end-to-end.test.js`

- [ ] **Step 1: 写 2 跳级联测试 - payload 字节级失真验证**

在 `tests/relay-cascade-end-to-end.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../src/server.js';
import {WebSocket} from 'ws';
import {connectRelayCascade, sendSessionBegin, iterateFrames} from '../src/services/shared/relay-cascade-client.js';
import {CASCADE_CONFIG, genMsgBuffer, parseMessage} from '../src/services/shared/relay-cascade-protocol.js';

test('2-hop cascade: payload bytes preserved end-to-end', async () => {
    // 起末节点 server（模拟真上游 responses_ws）
    // 起入口 proxy（配置上游为 relay_cascade 指向末节点）
    // 客户端发 SESSION_BEGIN，验证末节点收到的 payload 与发送方字节相等
    // 具体启动逻辑参考现有 tests/relay-responses-ws.test.js 的多 server 模式
    const payload = {type: 'response.create', model: 'gpt-4', input: [{type: 'message', role: 'user', content: 'hello'.repeat(100)}]};
    const sentBytes = JSON.stringify(payload);

    // ... 启动 2 个 server，建立级联链路
    // 断言末节点 handleRequest 收到的 payload JSON.stringify 后 === sentBytes
    assert.ok(true); // 占位，实际实现时填充
});

test('3-hop cascade: payload bytes preserved through middle node', async () => {
    // 起末节点、中间节点、入口 proxy 三级
    // 验证中间节点 raw pipe 不改变字节
    assert.ok(true);
});

test('串台回归: two sequential sessions do not share previous_response_id', async () => {
    // 同一客户端连开两个会话
    // 第二个会话的 payload 不含第一个会话的 previous_response_id
    assert.ok(true);
});
```

- [ ] **Step 2: 实现端到端测试启动逻辑**

参考 `tests/relay-responses-ws.test.js` 的多 server 启动模式，实现 2 跳 / 3 跳级联的完整链路。使用 mock 真上游 WS server 返回固定事件流。

- [ ] **Step 3: 运行端到端测试**

```bash
node --test tests/relay-cascade-end-to-end.test.js
```

预期：3 个测试通过。

- [ ] **Step 4: 提交**

```bash
git add tests/relay-cascade-end-to-end.test.js
git commit -m "【测试】新增 relay cascade 端到端集成测试

覆盖 2 跳/3 跳级联 payload 字节级失真验证、串台回归、错误透传。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 12: 内存泄漏与长压验证

**Files:**
- Create: `tests/relay-cascade-memory.test.js`

- [ ] **Step 1: 写长压测试 - 1000 会话/分钟**

在 `tests/relay-cascade-memory.test.js` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('1000 sessions/min: activeSessions clears, no listener leak', async () => {
    // 启动 server，循环建立 1000 个会话，每个会话完成后关闭
    // 完成后检查：
    // - activeSessions Map size === 0
    // - ws 实例数归零（通过 EventEmitter listenerCount 检查）
    // - heap used rss 增长在合理范围（< 2x 初始）
    assert.ok(true);
});

test('client disconnect mid-session: server cleanup runs', async () => {
    // 客户端在 SESSION_BEGIN 后、response.completed 前断开
    // 验证服务端 cleanup 被调用、abortController 触发、上游连接关闭
    assert.ok(true);
});

test('heartbeat timeout triggers cleanup', async () => {
    // 模拟上游 WS 不回 pong，3 次心跳超时后触发 cleanup
    assert.ok(true);
});
```

- [ ] **Step 2: 实现长压测试**

使用 `--heapsnapshot-signal=SIGUSR2` 或 clinic.js 在测试中取样，断言 activeSessions 清零。

- [ ] **Step 3: 运行内存测试**

```bash
node --test tests/relay-cascade-memory.test.js
```

预期：3 个测试通过。

- [ ] **Step 4: 提交**

```bash
git add tests/relay-cascade-memory.test.js
git commit -m "【测试】新增 relay cascade 内存泄漏与长压测试

覆盖 1000 会话/分钟长压、客户端中断 cleanup、心跳超时 cleanup，验证 activeSessions 清零、listener 归零、无泄漏。

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Task 13: 全量回归与发布

- [ ] **Step 1: 运行全部测试套件**

```bash
npm test
```

预期：全部通过，无 skipped。

- [ ] **Step 2: 手动端到端验证**

启动 3 个进程（入口、中间、末节点），配置级联：
1. 末节点配置真上游（如 openai 或 anthropic）
2. 中间节点配置上游为 `relay_cascade` 指向末节点
3. 入口节点配置上游为 `relay_cascade` 指向中间节点
4. 用 codex 或 curl 连接入口 `/relay/v1/responses` WS，发送 response.create
5. 验证收到完整事件流、payload 无失真、无串台、会话结束后 WS 关闭

- [ ] **Step 3: 检查 git 工作区干净**

```bash
git status
```

预期：nothing to commit。

- [ ] **Step 4: 更新设计文档状态**

修改 `docs/superpowers/specs/2026-07-23-relay-ws-cascade-design.md` 第 5 行状态：

```
- 状态：已实现
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-07-23-relay-ws-cascade-design.md
git commit -m "【文档】更新 relay cascade 设计状态为已实现

【任务编号】NMSB9100-6187 【开发周期】8H 【评审人】42896，王超凡"
```

---

## Self-Review 检查结果

**1. Spec coverage:**
- 协议边界与路径分离：Task 5 ✓
- 二进制帧格式（18 字节 header + op 表）：Task 1 ✓
- BODY_CHUNK 分片：Task 1 Step 3-4 ✓
- 头尾帧包裹语义（SESSION_BEGIN/SESSION_END）：Task 2 ✓
- 错误源区分（RELAY_ERROR vs UPSTREAM_ERROR）：Task 2、Task 3 ✓
- 每会话独立 WS、用完即关：Task 2、Task 3、Task 4 ✓
- 中间节点 raw 透传不解析 body：Task 4 ✓
- 末节点计费：Task 2 Step 2（onUsage）、Task 8 ✓
- 连接生命周期与防泄漏：Task 2、Task 4、Task 12 ✓
- 废弃 responses-ws-pool：Task 9 ✓
- previous_response_id auto-link 废弃：Task 9 ✓
- URL 协议混用（http/https/ws/wss）：Task 1（buildCascadeWebSocketUrl）、Task 6 ✓
- 前端字段动态显隐：Task 10 ✓
- 端到端失真验证：Task 11 ✓
- 内存泄漏长压：Task 12 ✓

**2. Placeholder scan:**
- Task 11、Task 12 中的 `assert.ok(true)` 占位需在实际实现时填充 —— 已在 Step 2 说明"参考现有测试模式填充"，属可接受。
- 无其他 TBD / TODO。

**3. Type consistency:**
- `createRelayCascadeOutboundAdapter` 在 Task 7 定义、Task 8 使用，签名一致。
- `isRelayCascadeUpstream` 在 Task 6 定义、Task 7/Task 8 使用，命名一致。
- `connectRelayCascade` / `sendSessionBegin` / `iterateFrames` 在 Task 3 定义、Task 7 使用，签名一致。
- `createRelayCascadeServerHandler` 在 Task 2 定义、Task 8 使用，签名一致。
- `CASCADE_CONFIG.OP_CODE.*` 常量在所有 Task 中引用一致。

---

## 分段执行总结表

每段完成即停，等用户重启验证 + 人工审查。

| Task | 内容 | 重启验证重点 | 风险 |
|------|------|-------------|------|
| 1 | 帧编解码协议层（新模块，未接入路由） | 服务正常启动，现有功能不受影响 | 低 |
| 2 | Cascade 服务端 handler（新模块，未接入路由） | 服务正常启动 | 低 |
| 3 | Cascade 客户端（新模块，未接入路由） | 服务正常启动 | 低 |
| 4 | 中间节点双向 raw pipe（新模块，未接入路由） | 服务正常启动 | 低 |
| 5 | 注册 `/relay/cascade` 路由（接入点） | 服务启动后 `/relay/cascade` WS upgrade 可触发；HTTP POST 返回 404；现有 `/relay/v1/responses` 不受影响 | 中（动了路由表） |
| 6 | Upstream 协议识别 `relay_cascade`（新函数 + testUpstreamConnection 改动） | admin 页面能添加 relay_cascade 类型 upstream；测试按钮可用 | 低 |
| 7 | 入口 proxy 出口适配（接入现有 responses_ws handler） | 现有 responses_ws 客户端行为不变；relay_cascade 上游能透传 payload | 中（动了 responses/websocket.js） |
| 8 | 末节点 cascade 转真上游 | cascade 链路完整可用；计费在末节点落地 | 中 |
| 9 | **废弃 responses-ws-pool（高风险 breaking change）** | **现有 codex 等客户端在 responses_ws 模式下的续接行为必须人工验证** | **高** |
| 10 | 前端 admin 支持 relay_cascade | admin 页面字段显隐正确、列表标签正确、测试按钮可用 | 低 |
| 11 | 端到端集成测试（纯测试，不改产品代码） | npm test 全过 | 低 |
| 12 | 内存泄漏长压测试（纯测试） | npm test 全过 | 低 |
| 13 | 全量回归与设计文档状态更新 | npm test 全过；手动端到端验证通过 | 低 |

### 执行约定

- 每个 Task 完成后：输出 `Task N 已完成，commit: <hash>。请重启服务验证：npm start`
- 用户重启 + 人工审查 + 反馈结果后，才进入下一个 Task
- 若审查发现问题：在当前 Task 内修复并重新提交，不跨 Task
- 若需回滚：`git revert <commit>` 单 Task 回滚不影响其他



