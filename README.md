# Claude API 代理服务

将 Claude API 请求转换为 OpenAI 格式的代理服务。

## 功能特点

- ✅ 支持 OpenAI 后端
- ✅ 支持流式响应 (SSE)
- ✅ 零外部依赖，纯 Node.js 原生实现
- ✅ 适合离线部署
- ✅ 基于 Transformer 架构，易于扩展

## 快速开始

### 环境要求

- Node.js >= 18.0.0

### 启动服务

```bash
# 直接运行
node src/index.js

# 或使用 npm
npm start

# 开发用
npm run dev
```

服务默认在端口 `3080` 启动，可通过 `PORT` 环境变量配置。

## 环境变量

| 变量名 | 说明     | 默认值    |
| ------ | -------- | --------- |
| `PORT` | 服务端口 | `3080`    |
| `HOST` | 绑定地址 | `0.0.0.0` |

# 参数说明
- URL 格式：{worker_url}/{type}/{provider_url_with_version}/v1/messages
- type: Transformer 类型，目前支持`openai`（对应 ClaudeToOpenAITransformer）
- provider_url_with_version: 目标厂商 API 基础地址
- x-api-key: 目标厂商的 API Key


# ~/.claude/settings.json
```json
{
    "env": {
        "ANTHROPIC_AUTH_TOKEN": "xxx",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/openai/https://api.deepseek.com",
        "ANTHROPIC_CUSTOM_HEADERS": "x-api-key: xxx",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-chat",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-chat",
        "API_TIMEOUT_MS": "60000",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    },
    "model": "opus"
}
```

#### 环境上部署
使用pm2包管理服务(依赖nodejs)
```bash
# 取消开机启动项
pm2 unstartup systemd

# 停止服务进程, 0是pm2的进程id 用pm2 list看
pm2 stop 0

# 删除服务进程，0是pm2的进程id 用pm2 list看
pm2 delete 0

# pm2 运行服务
pm2 start ./ecosystem.config.cjs

# 保存当前服务状态
pm2 save

# 设置开机启动
pm2 startup
```