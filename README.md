# Claude API 代理服务

为 Claude Code 提供多种 API 后端选择的代理服务，让你可以自由选择使用 GitHub Copilot、CodeBuddy 或其他 OpenAI 兼容 API。

## 项目说明

Claude Code 默认调用 Anthropic 的 Claude API。本项目作为中间代理层，将 Claude Code 的请求转发到你选择的后端：

- **模式 1: OpenAI 兼容 API** - 转发到 DeepSeek、OpenAI 等任何兼容 OpenAI 格式的服务
- **模式 2: GitHub Copilot** - 转发到 GitHub Copilot，利用 Copilot 订阅为 Claude Code 供能
- **模式 3: CodeBuddy** - 转发到腾讯 CodeBuddy，支持多租户、凭证轮换和 Web 管理面板
- **模式 4: Relay** - 通用多上游 LLM 代理，支持多租户、上游故障转移和 Web 管理面板

## 功能特点

- 多模式支持 - OpenAI 兼容 API / GitHub Copilot / CodeBuddy / Relay
- 完全兼容 Claude Code - 无需修改 Claude Code，只需配置环境变量
- 流式响应 - 完整 SSE 支持
- 轻量依赖 - 核心逻辑使用 Node.js 原生实现
- 多租户管理 - CodeBuddy 和 Relay 模块支持租户级别的凭证管理和用量追踪
- 凭证轮换 - CodeBuddy 支持自动凭证轮换
- 上游故障转移 - Relay 支持多上游配置和自动重试
- Web 管理面板 - 可视化租户、凭证和上游管理

---

## 模式选择

### 模式 1: 使用 GitHub Copilot

通过 GitHub Copilot 订阅为 Claude Code 提供 AI 能力，无需额外的 API Key 费用。

#### 快速开始

```bash
npm start  # 首次运行会自动引导 GitHub 认证
```

首次启动会显示认证链接，完成认证后 Token 自动保存，服务立即可用。

#### 配置 Claude Code

编辑 `~/.claude/settings.json`：
```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-4.1"
    }
}
```

---

### 模式 2: 使用 OpenAI 兼容 API

将 Claude 请求转发到任何 OpenAI 兼容的 API 服务。

URL 格式: `{服务地址}/{transformer类型}/{目标API地址}/v1/messages`

配置示例：
```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/openai/https://api.deepseek.com",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-xxxxx",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-chat"
    }
}
```

---

### 模式 3: CodeBuddy

转发到腾讯 CodeBuddy 服务，支持多租户凭证管理和自动轮换。

#### 快速开始

1. 启动服务后访问管理面板: `http://127.0.0.1:3080/codebuddyFE`
2. 添加租户并配置 CodeBuddy 凭证
3. 获取租户 API Key（格式: `sk-codebuddy-xxx`）

#### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-codebuddy-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/codebuddy/anthropic"
    }
}
```

#### 区域配置

CodeBuddy 支持国内站和国际站：

| 区域 | CODEBUDDY_REGION | 默认 URL |
|------|-----------------|-----------|
| 国内（默认） | `cn` | `https://copilot.tencent.com` |
| 国际 | `intl` | `https://www.codebuddy.ai` |

---

### 模式 4: Relay

通用多上游 LLM 代理，支持配置多个上游提供商和自动故障转移。

#### 快速开始

1. 启动服务后访问管理面板: `http://127.0.0.1:3080/relayFE`
2. 添加租户和上游配置
3. 获取租户 API Key（格式: `sk-relay-xxx`）

#### 配置 Claude Code

```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "sk-relay-xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/relay/anthropic"
    }
}
```

---

## 管理面板认证

CodeBuddy 和 Relay 的 Web 管理面板支持简单的用户名/密码登录。

### 首次配置

在 `.env` 中设置管理员账号：
```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
```

首次启动时会自动创建管理员用户。之后可以在管理面板中创建更多用户。

### 安全说明

- 密码使用 scrypt 算法加密存储
- 会话使用 JWT（HttpOnly, SameSite=Strict Cookie）
- 如果未配置用户，管理面板为开放访问

---

## 系统提示词注入

代理会在每个请求的 system message 前自动注入行为规则，引导模型使用中文思考、合理规划任务等。规则统一维护在 `src/config/system-prompts.js` 中，可按需增删。

---

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务端口 | `3080` |
| `HOST` | 绑定地址 | `0.0.0.0` |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `HTTP_PROXY` | HTTP 代理地址 | - |
| `HTTPS_PROXY` | HTTPS 代理地址 | - |
| `ADMIN_USERNAME` | 管理面板管理员用户名 | - |
| `ADMIN_PASSWORD` | 管理面板管理员密码 | - |
| `JWT_SECRET` | JWT 会话密钥（未设置时自动生成） | - |
| `JWT_EXPIRES_IN` | JWT 会话有效期 | `7d` |
| `CODEBUDDY_REGION` | CodeBuddy 区域 (`cn`/`intl`) | `cn` |
| `CODEBUDDY_DEFAULT_BASE_URL` | CodeBuddy 自定义上游 URL | 按区域选择 |
| `CODEBUDDY_CREDS_DIR` | CodeBuddy 凭证存储目录 | `.codebuddy` |
| `RELAY_CREDS_DIR` | Relay 凭证存储目录 | `.relay` |

---

## 开发和部署

### 本地开发

```bash
npm start

# 开发模式（带热重载）
npm run dev

# 调试模式
npm run debug
```

### PM2 部署

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

## 项目架构

```
src/
  index.js                    # 入口，初始化所有模块
  server.js                   # HTTP 服务器，路由分发
  router.js                   # 通用代理路由解析
  routes/
    copilot.js                # Copilot 路由
    codebuddy.js              # CodeBuddy API 路由
    codebuddy-frontend.js     # CodeBuddy 管理面板路由
    relay.js                  # Relay API 路由
    relay-frontend.js         # Relay 管理面板路由
  services/
    copilot/                  # Copilot 服务（GitHub OAuth, Token 管理）
    codebuddy/                # CodeBuddy 服务（API, 凭证轮换, 租户管理）
    relay/                    # Relay 服务（多上游, 故障转移, 租户管理）
    simple-auth.js            # 简单用户名/密码认证
    jwt-session.js            # JWT 会话管理
  transformer/
    claude-to-openai.js       # 通用 Claude → OpenAI 转换器
    shared-translator.js      # 公共翻译逻辑
  config/
    system-prompts.js         # 行为规则注入
    retry-config.js           # 重试配置
  utils/
    http-client.js            # HTTP 客户端（代理, 重试, 连接池）
    helpers.js                # 通用工具
    converter.js              # Anthropic ↔ OpenAI 格式转换
    token-estimation.js       # Token 估算
    logger.js                 # 日志
  templates/                  # 管理面板 HTML 模板
```

---

## 许可证

MIT License
