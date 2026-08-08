# Responses WebSocket 级联多模态支持设计

- 日期：2026-08-08
- 状态：已获用户批准，待规格复核

## 背景

当前部署链路通常是：

```text
Claude Code
  -> 本地 Relay Anthropic Messages
  -> 云端 Relay Responses WebSocket
  -> Kimi K3
```

现有代码已经支持普通用户消息中的部分图片转换，但 Claude Code 常见的工具返回图片仍存在缺口：Anthropic `tool_result.content` 中的图片会被整体 `JSON.stringify`，形成无效的工具输出语义。与此同时，Responses WebSocket 连接池在上游先发送 `response.created`、随后返回 400 时可能保留失败响应 ID；后续自动续接会继续引用该 ID，表现为图片请求失败后持续 400，重启云端后因连接池清空而恢复。

## 目标

1. 支持 Claude Code 常见的 Anthropic base64 图片。
2. 支持 Codex/Responses 的 `input_image` 格式。
3. 支持远程图片 URL 原样透传；Relay 不下载、不缓存、不转存远程图片。
4. 修复上游 400 后失败响应 ID 污染连接池的问题。
5. 保持现有本地 Relay -> 云端 Relay 的 Responses WebSocket 配置和连接池架构不变。

## 非目标

- 不新增独立的二进制 cascade 协议。
- 不修改 Claude Code、Codex 或 Kimi 的客户端协议。
- 不由 Relay 主动下载远程图片。
- 不在本次工作中重构 Responses WebSocket 连接池。

## 方案

采用最小范围的协议引擎和 Responses WebSocket 客户端修复：

1. 在 Anthropic -> Responses 转换中，把普通 `image` block 转为 `input_image`。
2. 对 `tool_result`：将文本内容保留在 `function_call_output.output`，把其中的图片拆成紧随其后的独立 user input item；同时保留 `x_relay_anthropic_tool_result`，让云端 Relay 在需要转换回 Anthropic 时恢复原始块。
3. 在 canonical session 中统一识别以下图片来源：
   - Anthropic `{type:"image", source:{type:"base64", media_type, data}}`
   - Anthropic `{type:"image", source:{type:"url", url}}`
   - Responses `{type:"input_image", image_url:"..."}`
   - Chat `{type:"image_url", image_url:{url:"..."}}`
   - 兼容 `image_url` 为对象的 Responses 变体。
4. canonical 渲染到 Chat、Responses、Anthropic 时，保留 data URL 和远程 URL；裸 base64 需要根据 `mediaType` 补成 `data:<mediaType>;base64,<data>`。
5. Responses WebSocket 请求收到上游 `error` 事件时，使本次请求产生的响应 ID 失效，避免连接池下一次自动注入失败的 `previous_response_id`。连接池仍按现有 context key 隔离。

## 数据流

### Claude Code base64 图片

```text
Anthropic image/source.base64
  -> anthropicRequestToResponses
  -> Responses input_image.image_url = data:<media>;base64,<data>
  -> 本地 Responses WebSocket
  -> 云端 Relay Responses WebSocket
  -> Kimi Responses/Chat 适配器
```

### 工具返回图片

```text
tool_result.content = [text, image]
  -> function_call_output.output = 仅文本
  -> 紧随其后的 user.content = [input_image]
  -> relay 私有字段保留原始 Anthropic tool_result
  -> 末端协议按目标格式渲染
```

### 远程 URL

```text
https://example/image.png
  -> input_image.image_url 原样保留
  -> 级联中间层只转发 JSON
  -> 不发起 HTTP 下载
```

## 失败状态处理

Responses WebSocket 客户端当前会在收到 `response.created` 时更新连接的 `lastResponseId`。本次请求随后出现 `error` 时，该 ID 可能并未代表一个可续接的成功响应。修复后：

- 记录本次请求开始前的 `previous_response_id`。
- 记录本次请求收到的 `response.created` ID。
- 收到上游错误时，清理本次请求产生的失败 ID。
- 如果错误发生在引用旧响应之后且没有产生新响应，也不允许错误请求继续污染自动续接状态。
- 成功收到 `response.completed` 时，保留现有的响应 ID跟踪行为。

目标是让下一次请求重新使用有效历史或完整输入，而不是自动引用刚刚失败的响应。

## 修改边界

预计修改：

- `src/protocol-engine/core/http-converters.js`
  - Anthropic tool result 图片拆分。
  - Anthropic/Codex 图片格式归一化。
- `src/protocol-engine/core/canonical/session.js`
  - 图片 data URL、远程 URL 和 tool result 图片的 canonical 往返渲染。
- `src/services/shared/responses-ws-client.js`
  - 上游错误后的失败响应 ID失效处理。

预计新增或扩展测试：

- `tests/protocol-anthropic-responses-converters.test.js`
- `tests/protocol-canonical-session.test.js`
- `tests/responses-ws-client.test.js`
- 必要时新增一个 Responses WebSocket 级联回归测试，验证两跳传输不下载 URL 且不复用失败响应 ID。

## 测试验收标准

1. Anthropic base64 图片转换后的 `image_url` 为合法 data URL。
2. Anthropic tool result 中的图片不会出现在 `function_call_output.output` 的 JSON 字符串中，而是出现在独立的 user `input_image` 中。
3. Codex `input_image` 的字符串和对象形式都能被 canonical 层识别并渲染到 Chat、Anthropic、Responses。
4. 远程 URL 在所有转换方向中保持原值，测试不产生网络请求。
5. 上游 `response.created` 后返回 400 时，连接池不再自动携带该失败 ID。
6. 现有测试全部通过。

## 风险与控制

- 不同 Responses 兼容服务对 `input_image.image_url` 的形状可能不同：canonical 层统一为字符串 URL，出站 Responses 遵循当前项目的字符串格式；兼容对象形状只作为入站解析格式。
- 工具结果的 `function_call_output.output` 只接受字符串：图片必须作为独立 user input item 发送，避免再次 JSON 化。
- 续接状态修改可能影响正常自动续接：通过“只清理失败请求产生的 ID”和新增回归测试限制影响范围。
- 超大 base64 会增加 WebSocket payload：本次不改变帧大小策略，只保留现有请求体和 WebSocket 限制；如生产代理有更小限制，应由部署配置调整。
