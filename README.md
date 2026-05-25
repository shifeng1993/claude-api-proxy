# Claude API Proxy

为 Claude Code 提供多后端 API 代理，让你无需修改客户端即可使用 GitHub Copilot、腾讯云 CodeBuddy 或 Relay 中继代理任意 AI 服务。

访问 `http://127.0.0.1:3080` 可进入主页，从中跳转到各服务的 Web 管理面板。

## 工作原理

```
Claude Code ──Anthropic格式──▶ Proxy ──OpenAI格式──▶ 上游AI服务
              ◀──Anthropic格式── Proxy ◀──OpenAI格式──
```

Proxy 核心做一件事：**Anthropic ↔ OpenAI ↔ Responses 三种协议互转**。Claude Code 以为自己在和 Anthropic API 通信，实际上请求被转发到了你选择的后端。

## 支持的后端

| 后端 | API 端点 | 管理面板 | 说明 |
|------|----------|----------|------|
| GitHub Copilot | `/copilot` | `/copilotFE` | GitHub Copilot Pro 订阅代理 |
| 腾讯 CodeBuddy | `/codebuddy/anthropic` | `/codebuddyFE` | CodeBuddy 订阅代理 · 凭证切换 · 企业站 |
| Relay 中继 | `/relay/anthropic` | `/relayFE` | 多上游配置 · 上游切换 |

---

## 快速开始

### 安装

```bash
npm install
npm start
```

服务启动后访问 `http://127.0.0.1:3080` 进入主页。

---

## GitHub Copilot

GitHub Copilot Pro 订阅代理，将 Claude Code 的请求转发到 Copilot 后端。

### 认证

首次启动时，访问管理面板 `http://127.0.0.1:3080/copilotFE` 完成 GitHub 设备码授权。授权成功后 Token 自动保存，后续无需重新认证。

管理面板同时提供：
- API Key 查看与重新生成
- 用量统计（请求数、Token 消耗）
- 代理配置（HTTP/HTTPS/SOCKS）

### 关于代理和可用模型

Copilot API 需要能访问 GitHub 服务。**国内网络需要配置代理**，在管理面板的"代理配置"中填写 HTTP/HTTPS/SOCKS 代理地址即可。

此外，Copilot 可用的模型取决于出口节点所在地区：

- **国内节点**：通常只能使用 GPT、Gemini 等模型，Claude 模型不可用
- **非国内节点**（如日本、美国、新加坡等）：可以访问 Copilot 中的 Claude 系列模型

因此如果想用 Claude 模型，需要将代理设置为非国内节点，然后在 Claude Code 配置中指定对应的 Claude 模型名（如 `claude-sonnet-4-6`）。

### 双格式端点

Copilot 同时提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic 三种格式的 API：

- **OpenAI 格式**：`/copilot/v1/chat/completions`、`/copilot/v1/models`
- **OpenAI Responses 格式**：`/copilot/v1/responses`（支持 Cherry Studio 等使用 Responses API 的客户端）
- **Anthropic 格式**：`/copilot/anthropic/v1/messages`、`/copilot/anthropic/v1/models`

#### 接口格式转换表

| 端点 | 请求 | 上游 | 返回 |
| ---- | ---- | ---- | ---- |
| `/copilot/v1/chat/completions` | OpenAI Chat | 优先走 Copilot Responses WS，失败回退 OpenAI Chat | OpenAI Chat |
| `/copilot/v1/responses` | OpenAI Responses | Copilot Responses WS | OpenAI Responses |
| `/copilot/v1/responses/compact` | Responses Compact | 转 OpenAI Chat 后发上游 | 再转回 Compact |
| `/copilot/anthropic/v1/messages` | Anthropic Messages | 优先转 Copilot Responses WS，失败回退 OpenAI Chat | Anthropic Messages |
| `/copilot/v1/models` | OpenAI Models 请求 | Copilot 模型列表 | OpenAI Models |
| `/copilot/anthropic/v1/models` | Anthropic Models 请求 | Copilot 模型列表 | Anthropic Models |
| `/copilot/anthropic/v1/messages/count_tokens` | Anthropic Count Tokens | 不调用上游 | 本地估算后按 Anthropic 格式返回 |

补充说明：

| 端点 | 备注 |
| ---- | ---- |
| `/copilot/v1/responses` | 支持流式 reasoning 输出 |
| `/copilot/v1/responses/compact` | 用于精简 Responses 客户端 |
| `/copilot/anthropic/v1/messages` | Claude Code 主要走这条 |

### Claude Code 工具调用兼容

`/copilot/anthropic/v1/messages` 针对 Claude Code 的 agent 场景做了专门适配：

- 支持 Claude Code 使用 GPT/Gemini/Copilot 模型执行工具调用，而不是必须消耗 Copilot 中的 Claude 高级模型请求。
- 支持 Anthropic `tool_use` / `tool_result` 与 Copilot Responses `function_call` / `function_call_output` 双向转换。
- 支持流式工具参数拼接：兼容首个 tool call chunk 直接携带完整 `arguments`、工具名晚到、以及 Copilot 只在 `response.completed.output` 返回完整 `function_call` 的情况。
- 支持本地 `count_tokens` 估算，Claude Code 的 token 统计请求不会转发到 Copilot 上游。

如果使用 Claude Code 执行一次需要 `N` 轮模型调用的任务：

- 直连 Copilot Claude 模型：通常会消耗约 `N` 次 Copilot Claude 高级请求。
- 通过本代理改用 Copilot 的 GPT/Gemini 模型：这 `N` 次请求不再计入 Claude 高级请求，相当于节省约 `N` 次 Copilot Claude 高级请求。

例如一次 agent 任务包含“初次分析 + 3 次工具调用后的继续推理 + 最终总结”，大约是 5 轮模型调用；改走 `gpt-5.4`、`gpt-5.4-mini`、`gpt-4.1` 等 Copilot 模型后，就可以节省约 5 次 Claude 高级请求。实际节省数量以 Claude Code 当次任务触发的模型调用轮数为准。

### 配置 Claude Code

编辑 `~/.claude/settings.json`：

使用 GPT 模型（国内节点可用）：

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-copilot-xxxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-4.1",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

使用 Claude 模型（需非国内节点代理）：

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-copilot-xxxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

> API Key 格式为 `sk-copilot-xxx`，在管理面板中查看。可用模型列表也可在管理面板的"模型列表"中实时查询。

---

## CodeBuddy

CodeBuddy 订阅代理，支持添加多个账号凭证手动切换。

### 可用模型

#### 国内站
| 模型 | 说明 | 工具 | 视觉 |
| ---- | ---- | :--: | :--: |
| `glm-5v-turbo` | GLM-5v-Turbo | ✓ | ✓ |
| `glm-5.1` | GLM-5.1 | ✓ | ✗ |
| `glm-5.0-turbo` | GLM-5.0-Turbo | ✓ | ✗ |
| `glm-4.6` | GLM-4.6 | ✓ | ✗ |
| `kimi-k2.6` | Kimi-K2.6 | ✓ | ✓ |
| `kimi-k2.5` | Kimi-K2.5 | ✓ | ✓ |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | ✓ | ✓ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | ✓ | ✓ |
| `deepseek-v3-2-volc` | DeepSeek-V3.2 | ✓ | ✗ |

#### 国际站
| 模型 | 说明 | 工具 | 视觉 |
| ---- | ---- | :--: | :--: |
| `glm-5.0` | GLM-5.0 | ✓ | ✗ |
| `kimi-k2.5` | Kimi-K2.5 | ✓ | ✓ |
| `gpt-5.5` | GPT-5.5 | ✓ | ✓ |
| `gpt-5.4` | GPT-5.4 | ✓ | ✓ |
| `gpt-5.3-codex` | GPT-5.3-codex | ✓ | ✓ |
| `gemini-3.5-flash` | Gemini-3.5-flash | ✓ | ✓ |
| `gemini-3.0-pro` | Gemini-3.0-pro | ✓ | ✓ |
| `gemini-3.0-flash` | Gemini-3.0-flash | ✓ | ✓ |
| `deepseek-v3-2-volc` | DeepSeek-V3.2 | ✓ | ✗ |

#### 企业站
| 模型 | 说明 | 工具 | 视觉 |
| ---- | ---- | :--: | :--: |
| `glm-5v-turbo` | GLM-5v-Turbo | ✓ | ✓ |
| `glm-5.1` | GLM-5.1 | ✓ | ✗ |
| `glm-5.0-turbo` | GLM-5.0-Turbo | ✓ | ✗ |
| `glm-4.7` | GLM-4.7 | ✓ | ✗ |
| `minimax-m2.7` | MiniMax-M2.7 | ✓ | ✗ |
| `kimi-k2.6` | Kimi-K2.6 | ✓ | ✓ |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | ✓ | ✓ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | ✓ | ✓ |
| `deepseek-v3-2-volc` | DeepSeek-V3.2 | ✓ | ✗ |

### 推理功能

支持 thinking 的模型会根据请求中的 `output_config.effort` 或 `thinking` 配置自动映射 `reasoning_effort`：

1. `output_config.effort`（Claude Code 传入：low/medium/high/max）
2. `thinking` 配置推断（disabled→low, adaptive→high, enabled 按 budget_tokens 分档）
3. 默认 `high`

### 多格式端点

CodeBuddy 同时提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic 三种格式的 API：

- **OpenAI 格式**：`/codebuddy/v1/chat/completions`、`/codebuddy/v1/models`
- **OpenAI Responses 格式**：`/codebuddy/v1/responses`（支持 Cherry Studio 等使用 Responses API 的客户端）
- **Anthropic 格式**：`/codebuddy/anthropic/v1/messages`、`/codebuddy/anthropic/v1/models`

Responses API 端点会将请求转换为 Chat Completions 格式发送到上游，再将响应转换回 Responses 格式返回。流式模式下完整支持 reasoning（thinking）输出。

#### 接口格式转换表

| 端点 | 请求 | 上游 | 返回 |
| ---- | ---- | ---- | ---- |
| `/codebuddy/v1/chat/completions` | OpenAI Chat | OpenAI Chat | OpenAI Chat |
| `/codebuddy/v1/responses` | OpenAI Responses | 转 OpenAI Chat 后发上游 | 再转回 OpenAI Responses |
| `/codebuddy/v1/responses/compact` | Responses Compact | 转 OpenAI Chat 后发上游 | 再转回 Compact |
| `/codebuddy/anthropic/v1/messages` | Anthropic Messages | 转 OpenAI Chat 后发上游 | 再转回 Anthropic Messages |
| `/codebuddy/v1/models` | OpenAI Models 请求 | CodeBuddy 模型列表 | OpenAI Models |
| `/codebuddy/anthropic/v1/models` | Anthropic Models 请求 | CodeBuddy 模型列表 | Anthropic Models |
| `/codebuddy/anthropic/v1/messages/count_tokens` | Anthropic Count Tokens | 不调用上游 | 本地估算后按 Anthropic 格式返回 |

补充说明：

| 端点 | 备注 |
| ---- | ---- |
| `/codebuddy/v1/responses` | 支持流式 reasoning 输出 |
| `/codebuddy/v1/responses/compact` | 用于精简 Responses 客户端 |
| `/codebuddy/anthropic/v1/messages` | Claude Code 主要走这条 |

### 快速开始

1. 访问 `http://127.0.0.1:3080/codebuddyFE` 进入管理面板
2. 添加一个或多个 CodeBuddy 账号凭证，选择活跃凭证
3. 复制 API Key（格式：`sk-codebuddy-xxx`）

### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-codebuddy-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/codebuddy/anthropic",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

### 凭证管理

- 支持多凭证手动切换，固定使用当前活跃凭证
- 管理面板 `/codebuddyFE` 支持 OAuth2 凭证添加、API Key 显示/隐藏/复制/重置
- 可在管理面板配置轮换次数阈值

### 站点与企业站

CodeBuddy 按凭证类型返回三类模型列表：

- **国内站**：`https://copilot.tencent.com`，使用国内站模型列表。
- **国际站**：`https://www.codebuddy.ai`，使用国际站模型列表。
- **企业站**：例如 `https://xxxx.copilot.qq.com`，但不依赖固定域名判断；只要凭证包含 `enterprise_id` / `enterpriseId` / `department_info` / `departmentInfo`，就使用企业站模型列表。

管理面板 `/codebuddyFE` 的使用指南会同时展示国内站、国际站和企业站的可用模型。也可以在管理面板的凭证编辑页面中针对每个凭证单独设置上游地址。

---

## Relay 中继

通用 LLM 中继代理，可配置多个上游并手动切换。可接入任意 OpenAI 兼容服务（DeepSeek 等），也可以将本地运行的 Copilot / CodeBuddy 端点作为上游。

同时提供 OpenAI Chat Completions、OpenAI Responses 和 Anthropic 三种格式的 API：

- **OpenAI 格式**：`/relay/v1/chat/completions`、`/relay/v1/models`
- **OpenAI Responses 格式**：`/relay/v1/responses`（支持 Cherry Studio 等使用 Responses API 的客户端）
- **Anthropic 格式**：`/relay/anthropic/v1/messages`、`/relay/anthropic/v1/models`

### 接口格式转换表

Relay 会根据上游配置中的 `protocol` 决定是直连还是做协议转换。目前支持 `openai`、`responses`、`anthropic` 三种上游类型。

| 端点 | 请求格式 | `openai` 上游 | `responses` 上游 | `anthropic` 上游 |
| ---- | -------- | ------------- | ---------------- | ---------------- |
| `/relay/v1/chat/completions` | OpenAI Chat | 直连 OpenAI Chat | 转 Responses 上游，再转回 OpenAI Chat | 不支持，改走 `/relay/anthropic/v1/messages` |
| `/relay/v1/responses` | OpenAI Responses | 转 OpenAI Chat，上游返回后再转回 Responses | Responses 直连 | 不支持，改走 `/relay/anthropic/v1/messages` |
| `/relay/v1/responses/compact` | Responses Compact | 转 OpenAI Chat，上游返回后再转回 Compact | Responses Compact 直连 | 不支持，改走 `/relay/anthropic/v1/messages` |
| `/relay/anthropic/v1/messages` | Anthropic Messages | 转 OpenAI Chat，上游返回后再转回 Anthropic Messages | 不支持，改走 `/relay/v1/responses` | Anthropic Messages 直连 |
| `/relay/v1/models` | OpenAI Models 请求 | OpenAI Models 直出 | Models 直出 | Anthropic Models 映射为 OpenAI Models |
| `/relay/anthropic/v1/models` | Anthropic Models 请求 | OpenAI Models 映射为 Anthropic Models | Models 映射为 Anthropic Models | Anthropic Models 直出 |
| `/relay/anthropic/v1/messages/count_tokens` | Anthropic Count Tokens | 本地估算 | 不支持，改走 `/relay/v1/responses` | Anthropic Count Tokens 直连 |

### 快速开始

1. 访问 `http://127.0.0.1:3080/relayFE` 进入管理面板
2. 添加一个或多个上游（URL + API Key + 可选代理），选择活跃上游
3. 复制 API Key（格式：`sk-relay-xxx`）

### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-relay-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/relay/anthropic",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

### 接入外部服务

在管理面板添加上游时填写对应信息：

| 服务 | Base URL | API Key |
| ---- | -------- | ------- |
| DeepSeek | `https://api.deepseek.com` | DeepSeek API Key |

> 需要代理的上游可在"代理"字段填写，支持 `http://`、`https://`、`socks5://` 格式。

### 接入本地 Copilot / CodeBuddy

Relay 可以将本机运行的 Copilot 或 CodeBuddy 端点作为上游，实现在 Relay 侧统一管理：

| 上游 | protocol | Base URL | API Key |
| ---- | -------- | -------- | ------- |
| GitHub Copilot | `openai` | `http://127.0.0.1:3080/copilot` | Copilot 的 `sk-copilot-xxx` |
| CodeBuddy OpenAI 模式 | `openai` | `http://127.0.0.1:3080/codebuddy` | CodeBuddy 的 `sk-codebuddy-xxx` |
| CodeBuddy Anthropic 模式 | `anthropic` | `http://127.0.0.1:3080/codebuddy/anthropic/v1` | CodeBuddy 的 `sk-codebuddy-xxx` |

> 如果 `anthropic` 上游的 Base URL 只填到了 `http://127.0.0.1:3080/codebuddy/anthropic`，Relay 会自动补全到 `/v1` 再去请求 `messages`、`models` 和 `messages/count_tokens`。

### 模型映射

不同上游的模型名称不同，可在管理面板的上游配置中设置**模型映射表**，将 Claude Code 请求的模型名自动转换为上游实际模型名。

示例（DeepSeek 上游）：

| Claude Code 请求模型 | 实际转发模型 |
| -------------------- | ------------ |
| `claude-sonnet-4-6` | `deepseek-v4-flash` |
| `claude-opus-4-6` | `deepseek-v4-pro` |

也可开启"**模型自动**"选项，将所有未匹配的模型名统一转发到该上游配置的默认模型。

代理已内置以下针对 DeepSeek / Kimi 的兼容性修复，无需额外配置：

1. **多轮 thinking 回传**：多轮对话时，助手消息中的 `thinking` 块会自动转换为 `reasoning_content` 字段回传给上游，符合 DeepSeek 和 Kimi 的多轮推理格式要求
2. **工具调用消息顺序**：系统提示词注入仅插入到普通 assistant 消息之后，不会插入到包含 `tool_calls` 的消息中，避免 DeepSeek / Kimi 因消息块顺序错误导致请求失败

---

## 系统提示词注入

代理会在每个请求的 system message 头部自动注入行为规则，引导模型使用中文思考、合理规划任务等。规则统一维护在 `src/config/system-prompts.js`，可按需增删。

---

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务监听端口 | `3080` |
| `HOST` | 绑定地址 | `0.0.0.0` |
| `LOG_LEVEL` | 日志级别（`DEBUG`/`INFO`/`WARN`/`ERROR`） | `INFO` |
| `CODEBUDDY_CREDS_DIR` | CodeBuddy 凭证存储目录 | `.codebuddy` |
| `RELAY_CREDS_DIR` | Relay 凭证存储目录 | `.relay` |

---

## 运行与部署

```bash
# 开发（带热重载）
npm run dev

# 生产
npm start

# 调试（输出 DEBUG 日志）
npm run debug
```

### PM2 部署

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## 项目结构

```
src/
  index.js                    # 入口，初始化所有模块
  server.js                   # HTTP 服务器与路由分发
  routes/
    copilot.js                # Copilot API 路由
    copilot-frontend.js       # Copilot 管理面板路由
    codebuddy.js              # CodeBuddy API 路由
    codebuddy-frontend.js     # CodeBuddy 管理面板路由
    relay.js                  # Relay API 路由
    relay-frontend.js         # Relay 管理面板路由
  services/
    copilot/                  # GitHub OAuth · Token 管理 · 用量统计
    codebuddy/                # CodeBuddy API · 凭证轮换
    relay/                    # 多上游管理 · 上游切换
  transformer/
    index.js                  # Transformer 注册与分发
    shared-translator.js      # 公共翻译逻辑（Anthropic ↔ OpenAI 格式互转）
    claude-to-openai.js       # 通用 Claude→OpenAI 转换器
    responses-translator.js   # Responses API ↔ Chat Completions 双向转换
  config/
    system-prompts.js         # 系统提示词注入规则
  utils/
    http-client.js            # HTTP 客户端
    converter.js              # Anthropic↔OpenAI 消息体转换
    token-estimation.js       # Token 用量估算
    logger.js                 # 日志
    helpers.js                # 通用工具函数
    circular-buffer.js        # 环形缓冲区
  templates/                  # 管理面板 HTML 模板
```

---

## License

MIT
