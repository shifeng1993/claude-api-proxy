# Claude API Proxy

为 Claude Code 提供多种 AI 后端接入的代理服务。项目监听 **3080 端口**，将 Claude Code 的 Anthropic API 请求转发到你选择的后端，无需修改 Claude Code 本身。

访问 `http://127.0.0.1:3080` 可进入主页，从中跳转到各服务的 Web 管理面板。

## 支持的后端

| 后端 | API 端点 | 管理面板 | 说明 |
|------|----------|----------|------|
| GitHub Copilot | `/copilot` | `/copilotFE` | GitHub Copilot Pro 订阅代理 |
| 腾讯 CodeBuddy | `/codebuddy/anthropic` | `/codebuddyFE` | CodeBuddy 订阅代理 · 多凭证轮换 · 国内/国际站 |
| Relay 中继 | `/relay/anthropic` | `/relayFE` | 多上游配置 · 单上游重试 |

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

因此如果想用 Claude 模型，需要将代理设置为非国内节点，然后在 Claude Code 配置中指定对应的 Claude 模型名（如 `claude-sonnet-4-5`）。

### 配置 Claude Code

编辑 `~/.claude/settings.json`：

使用 GPT 模型（国内节点可用）：

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-copilot-xxxx",
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
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-copilot-xxxx",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.6",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.6",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

> API Key 格式为 `sk-copilot-xxx`，在管理面板中查看。可用模型列表也可在管理面板的"模型列表"中实时查询。
> `ANTHROPIC_AUTH_TOKEN` 填 `dummy` 即可，实际鉴权通过 `ANTHROPIC_CUSTOM_HEADERS` 传递 `x-api-key`。

---

## CodeBuddy

CodeBuddy 订阅代理，支持添加多个账号凭证自动轮换。内置模型包括 GLM 5.1、Kimi K2.5、MiniMax M2.5、DeepSeek V3.2 等。

### 快速开始

1. 访问 `http://127.0.0.1:3080/codebuddyFE` 进入管理面板
2. 添加一个或多个 CodeBuddy 账号凭证（多个凭证自动轮换）
3. 复制 API Key（格式：`sk-codebuddy-xxx`）

### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/codebuddy/anthropic",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-codebuddy-xxx",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

### 区域与企业站

| 区域 | `CODEBUDDY_REGION` | 默认上游 |
|------|-------------------|---------|
| 国内（默认） | `cn` | `https://copilot.tencent.com` |
| 国际 | `intl` | `https://www.codebuddy.ai` |

腾讯云企业客户通常会有独立域名，可通过 `CODEBUDDY_EXTRA_BASE_URLS` 将一个或多个企业站地址添加到管理面板的上游下拉列表（逗号分隔）：

```env
CODEBUDDY_EXTRA_BASE_URLS=https://your-company.copilot.tencent.com,https://another.copilot.tencent.com
```

也可以在管理面板的凭证编辑页面中针对每个凭证单独设置上游地址，优先级高于环境变量。

---

## Relay 中继

通用 LLM 中继代理，可配置多个上游并手动切换，对当前活跃上游自动重试。可接入任意 OpenAI 兼容服务（DeepSeek 等），也可以将本地运行的 Copilot / CodeBuddy 端点作为上游。

### 快速开始

1. 访问 `http://127.0.0.1:3080/relayFE` 进入管理面板
2. 添加一个或多个上游（URL + API Key + 可选代理），选择活跃上游
3. 复制 API Key（格式：`sk-relay-xxx`）

### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/relay/anthropic",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-relay-xxx",
        "NO_PROXY": "localhost,127.0.0.1,::1"
    }
}
```

### 接入外部服务

在管理面板添加上游时填写对应信息：

| 服务 | Base URL | API Key |
|------|----------|---------|
| DeepSeek | `https://api.deepseek.com` | DeepSeek API Key |

> 需要代理的上游可在"代理"字段填写，支持 `http://`、`https://`、`socks5://` 格式。

### 接入本地 Copilot / CodeBuddy

Relay 可以将本机运行的 Copilot 或 CodeBuddy 端点作为上游，实现在 Relay 侧统一管理：

| 上游 | Base URL | API Key |
|------|----------|---------|
| GitHub Copilot | `http://127.0.0.1:3080/copilot` | Copilot 的 `sk-copilot-xxx` |
| CodeBuddy | `http://127.0.0.1:3080/codebuddy` | CodeBuddy 的 `sk-codebuddy-xxx` |

### 模型映射

不同上游的模型名称不同，可在管理面板的上游配置中设置**模型映射表**，将 Claude Code 请求的模型名自动转换为上游实际模型名。

示例（DeepSeek 上游）：

| Claude Code 请求模型 | 实际转发模型 |
|----------------------|------------|
| `claude-sonnet-4-5` | `deepseek-v4-flash` |
| `claude-opus-4-5` | `deepseek-v4-pro` |

也可开启"**模型自动**"选项，将所有未匹配的模型名统一转发到该上游配置的默认模型。

代理已内置以下针对 DeepSeek / Kimi 的兼容性修复，无需额外配置：

1. **多轮 thinking 回传**：Claude Code 多轮对话时，助手消息中的 `thinking` 块会自动转换为 `reasoning_content` 字段回传给上游，符合 DeepSeek 和 Kimi 的多轮推理格式要求
2. **工具调用消息顺序**：系统提示词注入仅插入到普通 assistant 消息之后，不会插入到包含 `tool_calls` 的消息中，避免 DeepSeek / Kimi 因消息块顺序错误导致请求失败

### 重试策略

请求失败时对当前活跃上游自动重试（可在管理面板配置重试次数，范围 1–5 次，也可以为每个上游单独配置）。

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
| `CODEBUDDY_REGION` | CodeBuddy 区域（`cn`/`intl`） | `cn` |
| `CODEBUDDY_DEFAULT_BASE_URL` | CodeBuddy 默认上游 URL（旧凭证兼容用） | 按区域选择 |
| `CODEBUDDY_EXTRA_BASE_URLS` | 额外企业站地址，逗号分隔，会出现在管理面板上游下拉列表 | — |
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
    relay/                    # 多上游管理 · 重试
  transformer/
    shared-translator.js      # 公共翻译逻辑（Anthropic ↔ OpenAI 格式互转）
  config/
    system-prompts.js         # 系统提示词注入规则
    retry-config.js           # 重试策略配置
  utils/
    http-client.js            # HTTP 客户端
    token-estimation.js       # Token 用量估算
    logger.js                 # 日志
    helpers.js                # 通用工具函数
    circular-buffer.js        # 环形缓冲区
  templates/                  # 管理面板 HTML 模板
```

---

## License

MIT
