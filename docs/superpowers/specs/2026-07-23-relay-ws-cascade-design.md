# Relay WebSocket 级联层剥离设计

- 日期：2026-07-23
- 作者：shi_feng
- 状态：已评审，待转入实现规划

## 背景与问题

当前项目在多级级联场景下（入口 proxy -> 中间 proxy -> 末节点 proxy -> 真上游），由于每跳都按 Responses API over WebSocket（responses_ws）协议处理 payload，产生多次冗余协议转换：

- `sanitizeResponsesInput` 反复清理 input
- `limitResponsesInputItems` 反复截断
- `prepareResponsesWebSocketPayload` 反复剥离私有字段
- 强制 `store:true` 反复覆盖
- `prepareResponsesContinuationPayload` 反复改写 input/id
- accumulator 反复重新累积响应事件

每跳都是一次"解析 -> 改写 -> 重新序列化"的往返，导致 payload 与 response 失真、信息丢失。此外现有 `responses-ws-pool`（ctx_pool 复用模式）在长对话场景下出现串台：新开会话残留老会话上下文、`connection.lastResponseId` auto-link 跨会话污染。

## 目标

- 把"WebSocket 级联传输"从"Responses API over WS（responses_ws）协议"中物理剥离，级联层只做传输，不做协议解析
- payload 在级联链路上原样透传，中间节点不解析、不改写、不计费
- 每会话独立 WS，用完即关，杜绝 pool 复用导致的串台
- 上游所有路径的 responses_ws 连接独立化，废弃 pool
- 计费只在末节点（连真上游那层）做

## 非目标

- 不修改客户端协议 `/v1/responses_ws`（对客户端仍是标准 Responses API over WS）
- 不修改真上游协议适配（responses_ws / responses HTTP / anthropic / chat 的出口逻辑保留）
- 不改 codebuddy 等其他服务的业务逻辑（仅 pool 机制随项目级调整一并废弃）

## 整体拓扑

```
 客户端        入口 proxy        中间 proxy        末节点 proxy       真上游
   |              |                 |                 |                |
   | responses_ws  |  relay cascade  |  relay cascade  |  真上游协议     |
   | (标准JSON帧)  | (二进制帧)      |  (二进制帧)     | (responses_ws/  |
   |              |                 |                 |  HTTP/anthropic)|
   |   WS-1       |    WS-cascade   |    WS-cascade   |                 |
```

## 协议边界

项目约定：同一路径通过 HTTP POST（普通 API）vs WebSocket upgrade（WS 模式）区分协议，路径名不带 `_ws` 后缀。级联层新增独立路径 `/relay/cascade`，仅通过 WS upgrade 触发；HTTP POST 到该路径返回 404 或 405。

| 协议 | 路径 | 触发方式 | 位置 | 职责 | 改动 |
|------|------|---------|------|------|------|
| responses HTTP | `/relay/v1/responses` | HTTP POST | 客户端 ↔ 入口proxy | 标准 Responses API（SSE） | 保留不动 |
| responses WS | `/relay/v1/responses` | WS upgrade | 客户端 ↔ 入口proxy | 标准 Responses API over WS（JSON 帧） | 保留不动 |
| relay cascade（新） | `/relay/cascade` | WS upgrade | proxy 间级联 | 自定义二进制帧，payload 透传，每会话独立 WS | 新增 |
| 真上游协议 | 各 upstream base_url | 按上游协议 | 末节点 ↔ 真上游 | responses_ws / responses HTTP / anthropic / chat | 不动 |

### URL 协议混用

级联链路上每跳的 base_url 可独立配置 `http://` / `https://` / `ws://` / `wss://`，互转规则与现有 `buildResponsesWebSocketUrl` 一致：

- `http://` ↔ `ws://`（明文，WS upgrade 时协议升级）
- `https://` ↔ `wss://`（TLS）
- 客户端配置时四种协议都接受，建立 WS 连接时按目标协议决定是否走 TLS

典型场景：入口 -> 中间跳 `http://`（内网明文），中间跳 -> 末节点 `https://`（跨网络加密），末节点 -> 真上游按真上游要求。每跳独立配置，互不影响。

配置示例：`http://127.0.0.1:3088/api/coding/relay/cascade`（客户端在 upstream base_url 里填这个，入口 proxy 识别为级联上游，建立 WS 连接到该地址）。

## 节点角色

- **入口 proxy**：接收客户端标准 responses_ws -> 解析出 payload -> 用二进制帧 SESSION_BEGIN 发给下游 -> 把下游回的 FRAME 转回标准 responses_ws 事件给客户端
- **中间 proxy**：双向 raw 透传二进制帧，不解析 body、不计费、不做协议转换
- **末节点 proxy**：收到 SESSION_BEGIN -> 解析 payload -> 转成真上游协议调用 -> 真上游响应事件逐个转成 FRAME -> 最终发 SESSION_END
- **计费**：只在末节点（连真上游那层）做，通过现有 `recordUsage` 落地

## 二进制帧格式

### 帧头布局（18 字节，大端序）

```
偏移  长度  字段        说明
0     4    packetLen   整包长度 = headerLen + bodyLen
4     2    headerLen   头部长度（固定 18）
6     4    version     协议版本（1 = body 为 UTF-8 JSON）
10    4    op          操作码（见下表）
14    4    seq         帧序号（会话内递增，便于乱序检测/日志）
```

body 紧跟 header，长度 = `packetLen - headerLen`。无 body 的帧（心跳）bodyLen = 0。

### OP 码表

| op  | 名称            | body                                                  | 方向       | 用途 |
|-----|-----------------|-------------------------------------------------------|------------|------|
| 2   | HEARTBEAT       | 无                                                    | 双向       | 保活，防中间代理超时切断 |
| 3   | HEARTBEAT_RESP  | 无                                                    | 双向       | 心跳回应 |
| 7   | AUTH            | `{token, session_id}`                                 | 下行->上游  | 级联间共享 secret 鉴权 + 声明会话 |
| 8   | AUTH_RESP       | `{ok, error?}`                                        | 上游->下行  | 鉴权结果 |
| 9   | BATCH           | 多个子帧拼接（每个子帧自带 header）                  | 双向       | 批量打包 FRAME，降帧开销 |
| 10  | SESSION_BEGIN   | payload JSON（response.create 内容，原样透传）        | 下行->上游  | 头帧：会话开始，携带整片 payload |
| 11  | FRAME           | responses 事件 JSON（response.created/in_progress/.../completed） | 上游->下行 | 中间帧：逐个事件 |
| 12  | SESSION_END     | `{usage?}` 或空                                       | 上游->下行  | 尾帧：会话结束 |
| 13  | RELAY_ERROR     | `{code, message, status?}`                            | 双向       | 级联层自身错误（鉴权失败、连接断开、心跳超时、帧格式错） |
| 14  | UPSTREAM_ERROR  | `{code, message, status?}`                             | 上游->下行  | 末节点从真上游收到的错误原样透传（上游 4xx/5xx、websocket_connection_limit_reached 等） |
| 15  | CANCEL          | 无或 `{reason?}`                                      | 下行->上游  | 客户端取消，透传到末节点 |
| 16  | BODY_CHUNK      | `{session_id, seq, total, data}`                      | 双向       | SESSION_BEGIN/FRAME 的 body 分片 |

### 头尾帧的包裹语义

一次完整会话在 relay cascade 协议上的形态：

```
下行（入口 -> 末节点）:
  AUTH {token, session_id: "sess-abc"}
  SESSION_BEGIN {type:"response.create", model:"...", input:[...], ...}   ← 头帧，整片 payload
  CANCEL  (可选，客户端取消时)

上行（末节点 -> 入口）:
  AUTH_RESP {ok:true}
  FRAME {type:"response.created", ...}
  FRAME {type:"response.in_progress", ...}
  FRAME {type:"response.output_item.added", ...}
  ...
  FRAME {type:"response.completed", response:{usage:{...}}}              ← 最后一个 FRAME
  SESSION_END {usage:{input_tokens, output_tokens, cache_hit_tokens}}    ← 尾帧
```

SESSION_BEGIN 的 body 就是客户端发来的 response.create payload 原样 JSON（入口 proxy 只做 JSON 序列化，不做 sanitize / limit / store 改写）。SESSION_END 的 body 可选带 usage 副本，入口 proxy 可据此日志，但不计费（计费只在末节点，通过末节点的 recordUsage 落地）。

### 错误源区分

- RELAY_ERROR（op=13）：级联层自身错误
  - `relay_auth_failed`：鉴权失败
  - `relay_disconnected`：下游 WS 断开
  - `relay_timeout`：心跳超时
  - `relay_protocol_error`：帧格式错误
  - `duplicate_session`：同一 WS 上第二个 AUTH
- UPSTREAM_ERROR（op=14）：末节点从真上游收到的错误原样透传

入口 proxy 收到 UPSTREAM_ERROR 仍按现有 responses_ws 的 `{type:'error', error:{...}}` 格式转给客户端；收到 RELAY_ERROR 转成 `{type:'error', error:{code:'relay_failed', message}}` 或细化的 `relay_auth_failed` / `relay_disconnected` / `relay_timeout`。

### 帧长度与分片

packetLen 为 Int32，理论上限 ~4GB。实际受三层约束：

| 约束 | 限制 | 应对 |
|------|------|------|
| WS 单帧大小 | 默认无上限，但 nginx/ALB 常配置 1MB~16MB 上限 | 文档要求级联链路上所有中间代理放宽到 ≥64MB |
| packetLen 字段 | Int32，上限 2^31-1 ≈ 2GB | 够用 |
| 大 payload（超长 input） | 单个 SESSION_BEGIN body 可能数 MB | 通常 < 16MB，不触发分片；超阈值时分片 |

分片机制（启用条件：body 超 `MAX_FRAME_BODY`，建议 1MB）：

- 发送端：原 body 序列化为 UTF-8 字节，按 1MB 切片，每片包成 BODY_CHUNK，seq 从 0 递增
- 接收端：缓存 `{session_id}` 的分片 buffer，到齐后拼成原 body，按原 op（SESSION_BEGIN / FRAME）走正常处理
- 拼接完成前的 partial buffer 有独立超时（30s），超时丢弃避免内存堆积
- 极端超长（几十 MB 代码仓库级别）：入口 proxy 检测后可直接拒绝 relay cascade，让客户端走 HTTP responses 降级

## 连接生命周期与内存管理

### 每会话独立 WS

- 入口 proxy 为每个客户端 response.create 建立一条到下游的 relay cascade WS 连接
- 这条连接 AUTH + SESSION_BEGIN + 收完 FRAME + SESSION_END 后关闭，不复用
- 与现有 responses-ws-pool（连接复用）完全独立，relay cascade 不入 pool
- 中间节点同理：每条入站 relay cascade 连接对应一条出站 relay cascade 连接，1:1 raw pipe

### 入口 proxy 侧生命周期

```
客户端 response.create 到达:
  1. 创建 AbortController（绑定到客户端 WS 生命周期）
  2. 新建到下游的 relay cascade WS 连接
  3. AUTH + SESSION_BEGIN 发送
  4. for-await 上游 FRAME 流:
       - 逐个转给客户端 WS
       - SESSION_END / UPSTREAM_ERROR / RELAY_ERROR 时 break
  5. finally:
       - 关闭下游 relay cascade WS（socket.close + 等待 close 事件或 5s 超时强关）
       - 清理：socket.removeAllListeners、心跳 timer、AbortController、buffer、accumulator
       - 从 activeSessions Map 中删除
  6. 客户端 WS close 时：AbortController.abort -> 触发 5 的清理
```

### 中间节点侧生命周期

1:1 双向 pipe。任一侧 close 即关闭另一侧、清两套 listener/timer。中间节点不维护 session 状态表，只维护"入站 socket <-> 出站 socket"的配对。

### 防内存泄漏硬性规则（不变量）

1. **一条 WS = 一个 session**：AUTH 必须带 `session_id`，服务端拒绝同一 WS 上第二个 AUTH（返回 RELAY_ERROR `duplicate_session`）
2. **双向清理**：客户端 close / 下游 close / AbortController abort / 超时，四条路径都走同一个 `cleanup()` 函数，且 cleanup 幂等（用 `closed` flag 守卫）
3. **超时兜底**：会话级总超时 = 客户端请求超时（透传，不在中间节点设独立总时长，避免级联链路上多个超时不一致）；心跳超时（3 次未收到 HEARTBEAT_RESP）触发关闭 + 清理
4. **listener 全部 off**：`socket.off('message'/'error'/'close')`、`clearInterval(pingTimer)`、`clearTimeout(cleanupTimer)` 必须在 finally 执行
5. **activeSessions 追踪**：进程级 Map 记录活跃 session，周期性扫描清理僵尸（close 事件丢失时兜底）；但首选依赖 close 事件，不把扫描当主路径
6. **上游 responses_ws 独立**：末节点连真上游 responses_ws 时也不入 pool，每会话独立连接、用完即关，与级联层一致

## 完整数据流

```
客户端                入口 proxy              中间 proxy              末节点 proxy          真上游
  |                      |                       |                       |                    |
  | WS-1 (responses_ws)  |                       |                       |                    |
  | {type:response.create|                       |                       |                    |
  |  ...payload...}      |                       |                       |                    |
  |-------------------->|                       |                       |                    |
  |                      | 新建 WS-cascade 到下游|                       |                    |
  |                      | AUTH {token,sess_id}  |                       |                    |
  |                      |---------------------->| 新建 WS-cascade 到下游|                    |
  |                      |                       | AUTH {token,sess_id}  |                    |
  |                      |                       |---------------------->| 新建到真上游的连接  |
  |                      |                       |                       | (responses_ws独立  |
  |                      |                       |                       |  /HTTP/anthropic)  |
  |                      |                       |                       |-------------------->|
  |                      |                       |                       |   真上游协议请求    |
  |                      |                       |                       |<--------------------|
  |                      |                       |                       | 真上游响应事件流     |
  |                      |                       | AUTH_RESP {ok}        |                    |
  |                      |<----------------------|                       |                    |
  |                      |<--AUTH_RESP-----------|                       |                    |
  |                      |                       |                       |                    |
  |                      | SESSION_BEGIN {payload}                       |                    |
  |                      |---------------------->| 原样转发               |                    |
  |                      |                       |---------------------->| payload 解析      |
  |                      |                       |                       | -> 转真上游协议    |
  |                      |                       | FRAME {response.created}                   |
  |                      |<----------------------| 原样转发               |                    |
  |                      |<--FRAME---------------|                       |                    |
  | {type:response.created}                      |                       |                    |
  |<--------------------|                       |                       |                    |
  | ...更多 FRAME...    |                       |                       |                    |
  | {type:response.completed}                    |                       |                    |
  |<--------------------|                       |                       |                    |
  |                      | SESSION_END {usage}  |                       |                    |
  |                      |<----------------------| 原样转发               |                    |
  |                      |                       |<---------------------| recordUsage(末节点) |
  |                      | 关闭 WS-cascade       |                       | 关闭真上游连接     |
  |                      |---------------------->| 关闭 WS-cascade       |                    |
  |                      |                       |---------------------->|                    |
  | WS-1 保持/关闭       |                       |                       |                    |
  |（按客户端协议）      |                       |                       |                    |
```

## 错误处理矩阵

| 错误场景 | op | body | 处理 |
|---------|----|----|------|
| 级联鉴权失败（token 错） | RELAY_ERROR | `{code:'relay_auth_failed'}` | 入口转 `{type:'error', error:{code:'unauthorized'}}` 给客户端 |
| 下游 WS 断开 | RELAY_ERROR | `{code:'relay_disconnected'}` | 入口转 `{type:'error', error:{code:'server_error'}}` |
| 心跳超时 | RELAY_ERROR | `{code:'relay_timeout'}` | 入口转 `{type:'error', error:{code:'timeout'}}` |
| 帧格式错误 | RELAY_ERROR | `{code:'relay_protocol_error'}` | 入口转 `{type:'error', error:{code:'bad_request'}}` |
| 真上游 4xx/5xx | UPSTREAM_ERROR | 原样透传 | 入口转 `{type:'error', error:...}` 给客户端 |
| 真上游 websocket_connection_limit_reached | UPSTREAM_ERROR | 原样透传 | 入口按现有逻辑处理 |
| 客户端取消 | CANCEL | `{reason?}` | 透传到末节点，调用真上游 cancel |
| 客户端超时 | AbortController | - | 入口关下游 WS，给客户端发 timeout error |
| 同一 WS 第二个 AUTH | RELAY_ERROR | `{code:'duplicate_session'}` | 拒绝并关闭连接 |
| BODY_CHUNK 拼接超时（30s） | RELAY_ERROR | `{code:'chunk_timeout'}` | 丢弃 partial buffer，关闭连接 |

## 代码组织

### 新增模块

```
src/services/shared/
  relay-cascade-protocol.js   # 帧编解码（genHeaderBuffer/parseMessage/分片拼接）
  relay-cascade-server.js     # /relay/cascade 服务端 handler（入口/中间节点用）
  relay-cascade-client.js     # 连接下游 /relay/cascade 的客户端（入口/中间节点用）
  relay-cascade-pipeline.js   # 中间节点双向 pipe（raw 透传）
src/services/relay/
  protocols/relay-cascade.js   # 入口 proxy 的 relay cascade 出口适配（类似现有 responses/websocket.js 的位置）
```

现有 `responses-ws-server.js` / `responses-ws-client.js` / `responses-ws-pool.js` 不动，它们继续服务客户端协议与未走级联的上游 responses_ws 出口。

### 路由

- 新增 `/relay/cascade`：relay cascade 服务端 WS upgrade 入口（HTTP POST 到该路径返回 404/405）
- 在 `server.on('upgrade')` 的 `wsRoutes` 表中添加该路径，指向 `handleRelayCascadeWS`
- upstream 协议下拉新增 `relay_cascade` 选项，选中时表单字段动态显隐

## 前端字段调整

upstream 编辑表单按协议动态显隐：

| 字段 | openai | responses | responses_ws | anthropic | relay_cascade（新） |
|------|:---:|:---:|:---:|:---:|:---:|
| name | ✓ | ✓ | ✓ | ✓ | ✓ |
| base_url | ✓ | ✓ | ✓ | ✓ | ✓（指向下游 `/relay/cascade`，支持 http/https/ws/wss） |
| api_key | ✓ | ✓ | ✓ | ✓ | ✓（级联间共享 secret） |
| proxy | ✓ | ✓ | ✓ | ✓ | ✓ |
| skip_tls_verify | ✓ | ✓ | ✓ | ✓ | ✓ |
| model_map | ✓ | ✓ | ✓ | ✓ | ✗（级联层不碰模型，原样透传） |
| protocol 下拉 | ✓ | ✓ | ✓ | ✓ | ✓ |
| ws_mode | ✗ | ✗ | ✓ | ✗ | ✗（级联层无 pool 模式） |
| disable_responses_continuation | ✗ | ✓ | ✓ | ✗ | ✗（续接是末节点的事） |
| enable_responses_incremental | ✗ | ✓ | ✓ | ✗ | ✗ |

列表卡片上 relay_cascade 类型的 upstream 显示"级联"标签；测试按钮改为"连通性 ping"（发心跳帧验活）。

## 项目级调整：上游所有路径 responses_ws 独立化

### 决策

把 `responses-ws-pool`（ctx_pool 复用模式）整个弃用。所有上游 WS 连接改为每会话独立、用完即关。这是整个项目的调整，影响所有路径。

### 影响范围

| 路径 | 现状 | 调整 |
|------|------|------|
| relay `/v1/responses_ws` | pool 复用上游 responses_ws | 独立，每会话新建上游 WS，用完即关 |
| codebuddy `/v1/responses_ws` | pool 复用 | 独立 |
| 真上游 responses_ws（末节点出口） | pool 复用 | 独立 |
| `responses-ws-pool.js` | 活跃使用 | 弃用（可保留文件但不再调用，或彻底删除） |
| `responses_ws_mode = ctx_pool` | 默认值 | 改为 `off`，pool 相关分支不再执行 |
| `connection.lastResponseId` auto-link | 依赖 pool 的连接对象长期持有 | 失效，previous_response_id 续接改为会话级 state 持久（见下） |

### previous_response_id 续接替代方案

原 pool 模式靠 `connection.lastResponseId` 在同一上游 WS 上 auto-link。独立后连接关闭即丢，改为：

- **会话级存储**：末节点把每个 session 的 `lastResponseId` 存到 `relayConversationStore`（或 Redis/DB），按 `session_id` 查找
- **客户端显式带**：客户端在后续 response.create 里带 `previous_response_id`（codex 等客户端已支持），末节点原样转发给真上游
- **auto-link 机制废弃**：不再自动注入 previous_response_id，由客户端显式提供或由末节点从会话存储恢复

### Breaking change

`previous_response_id` auto-link 废弃。依赖该机制的不带 `previous_response_id` 的客户端会续接失败。迁移路径：客户端改为显式带 `previous_response_id`，或末节点从 `relayConversationStore` 按 `session_id` 恢复 `lastResponseId` 后注入。

## 测试策略

| 层级 | 测试内容 | 工具 |
|------|---------|------|
| 单元 - 帧编解码 | `relay-cascade-protocol.js`：genMsgBuffer/parseMessage round-trip、边界值（空 body、超长 body 触发分片）、坏 header（长度不足、packetLen 越界） | `node --test` |
| 单元 - 生命周期 | 入口/中间/末节点的 session cleanup 幂等性：close 事件丢失时 activeSessions 兜底清理、AbortController abort 触发 cleanup、心跳超时触发 cleanup | `node --test` + 模拟 ws |
| 集成 - 2 跳级联 | 入口 -> 中间 -> 末节点，payload 原样透传，FRAME 顺序完整，SESSION_END 后所有 WS 关闭、listener 清空、无泄漏 | 本地起 3 个进程 |
| 集成 - 3 跳级联 | 同上，加一跳，验证中间节点 raw pipe 不引入失真 | 本地起 4 个进程 |
| 失真验证 | 对比"客户端 payload 字节 == 末节点收到的 payload 字节" | 断言 `JSON.stringify(payload)` 相等 |
| 错误透传 | 真上游 4xx -> UPSTREAM_ERROR -> 客户端 error 事件；下游断开 -> RELAY_ERROR -> 客户端 error 事件 | mock 真上游 |
| 取消传播 | 客户端 response.cancel -> CANCEL -> 末节点 cancel 真上游 | mock 真上游 |
| 分片 | payload > 1MB 触发 BODY_CHUNK，拼接还原后字节相等 | 构造超大 input |
| 内存泄漏 | 长压（1000 会话/分钟）后 heap snapshot，验证 activeSessions 清零、ws 连接数清零、listener 计数归零 | clinic.js / --heapsnapshot |
| 串台回归 | 同一客户端连开两个会话，验证第二个会话不含第一个的 previous_response_id / accumulator 残留 | 端到端 |
| 现有 responses_ws 回归 | 客户端协议不变，现有 codex/客户端行为不受影响 | 现有测试套件 |
| 独立化回归 | 上游 responses_ws 连接用完即关，无 pool 复用，无 lastResponseId 残留 | 端到端 |

## 影响面汇总

### 新增

- `relay-cascade-protocol.js`、`relay-cascade-server.js`、`relay-cascade-client.js`、`relay-cascade-pipeline.js`
- `src/services/relay/protocols/relay-cascade.js`（出口适配）
- `/relay/cascade` WS upgrade 路由
- upstream 协议下拉新增 `relay_cascade` 选项
- 前端 admin.html：relay_cascade 协议选项 + 字段动态显隐 + 列表"级联"标签 + 连通性 ping

### 修改

- `responses-ws-mode.js`：`RESPONSES_WS_MODE_CTX_POOL` 弃用，默认改 `off`
- `responses-ws-client.js`：移除 pool 相关逻辑，改为每会话独立
- `responses-ws-pool.js`：弃用或删除
- upstream 出口路径：所有 responses_ws 出口改为独立连接
- `autoLink` / `connection.lastResponseId` 机制废弃，previous_response_id 改为客户端显式或末节点会话存储
- 前端 admin.html：upstream 表单新增 `relay_cascade` 协议选项 + 字段动态显隐

### Breaking change

- `previous_response_id` auto-link 废弃，依赖该机制的不带 `previous_response_id` 的客户端会续接失败
- `responses_ws_mode = ctx_pool` 弃用，老配置降级为 `off`

## 开放问题

无。所有关键决策已在评审中确认：

1. 剥离形态：URL 路径分离（`/relay/cascade` 独立路径，仅 WS upgrade 触发）
2. 帧格式：自定义二进制帧（18 字节 header + op 语义）
3. 错误源区分：RELAY_ERROR vs UPSTREAM_ERROR 双 op
4. 超长帧：BODY_CHUNK 分片
5. 会话超时：按客户端超时走
6. 上游 responses_ws 独立化：整个项目调整，所有路径独立
7. auto-link 废弃：接受 breaking change
8. 计费位置：只在末节点
