# Claude Code 多后端代理服务

为 Claude Code 提供多种 API 后端选择的代理服务,让你可以自由选择使用 GitHub Copilot 或其他 OpenAI 兼容 API。

## 📖 项目说明

Claude Code 默认调用 Anthropic 的 Claude API。本项目作为中间代理层,将 Claude Code 的请求转发到你选择的后端:

- **模式 1: OpenAI 兼容 API** - 转发到 DeepSeek、OpenAI 等任何兼容 OpenAI 格式的服务
- **模式 2: GitHub Copilot** - 转发到 GitHub Copilot,利用 Copilot 订阅为 Claude Code 供能

## ✨ 功能特点

- ✅ **双模式支持** - 自由选择 OpenAI 兼容 API 或 GitHub Copilot
- ✅ **完全兼容 Claude Code** - 无需修改 Claude Code,只需配置环境变量
- ✅ **流式响应** - 完整 SSE 支持
- ✅ **零外部依赖** - 纯 Node.js 原生实现(OpenAI 模式)
- ✅ **自动 Token 管理** - Copilot Token 自动获取和刷新
- ✅ **易于扩展** - 基于 Transformer 架构

---

## 🚀 模式选择

### 模式 1: 使用 GitHub Copilot (推荐)

通过 GitHub Copilot 订阅为 Claude Code 提供 AI 能力,无需额外的 API Key 费用。

#### ⚡ 快速开始

**步骤 1: 启动服务**
```bash
npm start  # 首次运行会自动引导 GitHub 认证
```

首次启动会显示认证链接，完成认证后 Token 自动保存，服务立即可用。

**步骤 2: 配置 Claude Code**

编辑 `~/.claude/settings.json`：
```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "dummy",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/copilot",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-4.1",
        "API_TIMEOUT_MS": "60000",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
}

```

**步骤 3: 开始使用**

打开 Claude Code 即可使用！后续启动只需 `npm start`。

#### � 查询可用模型

启动服务后，你可以查询 GitHub Copilot 支持的模型列表：

```bash
curl http://127.0.0.1:3080/copilot/v1/models
```

这将返回所有可用的模型及其配置信息（如 token 限制、支持的功能等），你可以根据返回的模型 ID 来配置 Claude Code 的模型参数。

#### �💡 Token 管理

- **GitHub Token**: 从 GitHub OAuth 获取，长期有效，保存在 `.copilot/github_token`
- **Copilot Token**: 自动从 GitHub Token 获取，30 分钟有效，自动刷新
- 完全自动化，无需手动配置

#### 🧪 快速测试

```bash
curl -X POST http://127.0.0.1:3080/copilot/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

---

### 模式 2: 使用 OpenAI 兼容 API

将 Claude 请求转发到任何 OpenAI 兼容的 API 服务，如 DeepSeek、OpenAI 等。

#### 配置说明

URL 格式: `{服务地址}/{transformer类型}/{目标API地址}/v1/messages`

- `transformer类型`: 目前支持 `openai` (ClaudeToOpenAITransformer)
- `目标API地址`: 如 `https://api.deepseek.com`
- `x-api-key`: 目标服务的 API Key

#### 配置示例

编辑 `~/.claude/settings.json`：
```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/openai/https://api.deepseek.com",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: sk-xxxxx",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-chat",
        "API_TIMEOUT_MS": "60000",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
}
```

---

## 🔧 常见问题

**Q: 如何选择使用哪种模式？**

- 有 GitHub Copilot 订阅 → 使用模式 1 (Copilot)
- 有其他 API Key (DeepSeek等) → 使用模式 2 (OpenAI兼容)

**Q: Claude Code 连接失败怎么办？**

检查项:
1. 服务是否运行: `curl http://127.0.0.1:3080/`
2. 端口是否正确: 默认 3080
3. Token 是否有效(Copilot 模式): `cat .copilot/github_token`

**Q: 如何查看详细日志？**
```bash
LOG_LEVEL=DEBUG npm start
```

**Q: Copilot Token 过期怎么办？**

自动刷新，无需手动处理。如需重新认证:
```bash
rm -rf .copilot/
npm start  # 重新走认证流程
```

**Q: 如何更换 GitHub 账号？**
```bash
rm .copilot/github_token
npm start
```

**Q: 如何在两种模式之间切换？**

只需修改 `~/.claude/settings.json` 中的 `ANTHROPIC_BASE_URL`:
- Copilot 模式: `http://127.0.0.1:3080/copilot`
- OpenAI 模式: `http://127.0.0.1:3080/openai/https://api.xxx.com`

无需重启服务,Claude Code 会自动使用新配置。

---

## ⚙️ 环境变量

| 变量名      | 说明     | 默认值    |
| ----------- | -------- | --------- |
| `PORT`      | 服务端口 | `3080`    |
| `HOST`      | 绑定地址 | `0.0.0.0` |
| `LOG_LEVEL` | 日志级别 | `INFO`    |

---

## 🛠 开发和部署

### 本地开发

```bash
# 启动服务
npm start

# 开发模式（带热重载）
npm run dev
```

### PM2 部署

```bash
# 启动服务
pm2 start ecosystem.config.cjs

# 保存当前状态
pm2 save

# 设置开机启动
pm2 startup

# 取消开机启动项
pm2 unstartup systemd

# 停止服务
pm2 stop ClaudeApiProxy

# 删除服务
pm2 delete ClaudeApiProxy
```

---

## 📦 项目架构

本项目包含两个核心模块:

- **根目录 (OpenAI 模式)** - 纯 Node.js 实现的 Claude 到 OpenAI 格式转换器
  - 轻量级,无外部依赖
  - 支持任何 OpenAI 兼容 API
  
- **copilot-api 子模块 (Copilot 模式)** - GitHub Copilot API 反向代理
  - 基于 Bun 运行时
  - 提供完整的 Copilot API 兼容层
  - 自动 Token 管理和刷新

两种模式共享同一服务端口(3080),通过不同的路由前缀区分(`/copilot` vs `/openai`)。

---

## 📝 许可证

MIT License