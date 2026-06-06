# Claude API Proxy

Claude API Proxy 是一个统一的 AI 服务控制台和协议代理。它在一个管理界面中纳管 Relay、CodeBuddy、GitHub Copilot、用户账号、使用统计和问题反馈，并在服务侧完成 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Responses WebSocket 之间的协议转换。

控制台入口：

```text
http://127.0.0.1:3080/admin
```

控制台使用 hash 路由，刷新后会停留在当前页面，例如 `#/dashboard/overview`、`#/dashboard/relay`、`#/stats/relay/users`。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 统一 API Key | 每个用户/租户拥有一个 `sk-...` API Key，可访问已启用的服务 |
| Relay 中继 | 支持 OpenAI Chat、OpenAI Responses、Responses WebSocket、Anthropic 上游 |
| 多协议桥接 | Relay 客户端协议和上游协议可交叉组合，尽量保持流式边收边转 |
| CodeBuddy 代理 | 管理 CodeBuddy 凭证、自定义上游和模型覆盖 |
| GitHub Copilot 代理 | 通过设备授权保存 GitHub Token，按租户隔离刷新 Copilot Token |
| 统一登录 | 启动时探测 LDAP；LDAP 不可用或未配置时自动切换为本地账号 |
| 用户管理 | superadmin 管理管理员和普通用户；admin 管理普通用户 |
| 使用统计 | 用户排行、模型分析、用户趋势、缓存命中率、积分消耗和管理员使用建议 |
| 问题反馈 | 用户提交反馈，管理员处理状态和附件 |

## 控制台页面

| 页面 | hash | 说明 |
| --- | --- | --- |
| 服务控制台 | `#/dashboard/overview` | 查看统一 API Key 和服务启用状态 |
| Relay | `#/dashboard/relay` | 管理 Relay 上游、协议、模型映射、代理和 TLS |
| CodeBuddy | `#/dashboard/codebuddy` | 管理 CodeBuddy 凭证和 Claude Code 配置 |
| Copilot | `#/dashboard/copilot` | 管理 GitHub Copilot 授权和凭据 |
| 使用统计 | `#/stats/relay/users` | 按 Relay、CodeBuddy、Copilot 端点分别查看；管理员额外可看使用建议 |
| 问题反馈 | `#/feedback` | 提交、查看和处理反馈 |
| 用户管理 | `#/users` | 管理本地账号和角色 |

旧入口 `/relayFE`、`/codebuddyFE`、`/copilotFE` 会重定向到 `/admin`。

## 快速启动

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell 可以使用：

```powershell
Copy-Item .env.example .env
npm.cmd start
```

最小配置：

```env
PORT=3080
HOST=0.0.0.0
JWT_SECRET=<a-long-random-secret>

DB_DIALECT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=<db-password>
DB_NAME=claude_api_proxy

LOCAL_ADMIN_USER=admin
LOCAL_ADMIN_PASSWORD=<at-least-8-chars>
```

如果配置了 `LDAP_SERVER`、`LDAP_BIND_DN`、`LDAP_BIND_PASSWORD`、`LDAP_BASE_DN` 且 LDAP 可达，登录页会进入 LDAP 认证模式；否则进入本地账号认证模式，并同步 `LOCAL_ADMIN_USER` 为 superadmin。

## Relay 协议支持

Relay 客户端入口支持三类协议，活跃上游支持四类协议，因此可以覆盖 16 种调用组合。

| 客户端入口 | 上游 `openai` | 上游 `responses` | 上游 `responses_ws` | 上游 `anthropic` |
| --- | --- | --- | --- | --- |
| Anthropic Messages | Anthropic -> Chat | Anthropic -> Responses | Anthropic -> Responses WS | 直通 |
| OpenAI Chat | 直通 | Chat -> Responses | Chat -> Responses WS | Chat -> Anthropic |
| OpenAI Responses | Responses -> Chat | 直通 | Responses -> Responses WS | Responses -> Anthropic |
| Responses WebSocket | WS -> Chat | WS -> Responses HTTP | WS 直通/复用 | WS -> Anthropic |

说明：

- `responses_ws` 上游会复用 WebSocket 连接，并按上下文尝试携带 `previous_response_id`。
- 跨协议流式路径尽量边收边转，避免先聚合完整响应再返回。
- Anthropic `messages/count_tokens` 只有 Anthropic 上游可直通；其他上游会用本地估算返回。
- Claude 没有 `/v1/usage`，项目不提供该别名。
- 模型名默认原样透传。需要改名时，在 Relay 上游配置里使用模型映射。

## API 入口

所有服务都使用统一 API Key 鉴权。Claude Code 推荐使用 `ANTHROPIC_AUTH_TOKEN`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3080/relay/anthropic",
    "NO_PROXY": "localhost,127.0.0.1,::1"
  }
}
```

### Relay

| 协议 | HTTP 入口 |
| --- | --- |
| Anthropic Messages | `POST /relay/anthropic/v1/messages` |
| Anthropic Count Tokens | `POST /relay/anthropic/v1/messages/count_tokens` |
| Anthropic Models | `GET /relay/anthropic/v1/models` |
| OpenAI Chat Completions | `POST /relay/v1/chat/completions` |
| OpenAI Responses | `POST /relay/v1/responses` |
| Responses Compact | `POST /relay/v1/responses/compact` |
| OpenAI Models | `GET /relay/v1/models` |

Responses WebSocket 使用同一路径升级：

```text
ws://127.0.0.1:3080/relay/v1/responses
```

Relay 上游字段包括 `protocol`、`base_url`、`api_key`、`proxy`、`skip_tls_verify`、`model_map`、启用状态和活跃顺序。代理支持 `http://`、`https://`、`socks://`、`socks4://`、`socks5://`；跳过 TLS 证书验证在代理地址输入框下方配置。

### CodeBuddy

| 协议 | HTTP 入口 |
| --- | --- |
| Anthropic Messages | `POST /codebuddy/anthropic/v1/messages` |
| Anthropic Count Tokens | `POST /codebuddy/anthropic/v1/messages/count_tokens` |
| Anthropic Models | `GET /codebuddy/anthropic/v1/models` |
| OpenAI Chat Completions | `POST /codebuddy/v1/chat/completions` |
| OpenAI Responses | `POST /codebuddy/v1/responses` |
| Responses Compact | `POST /codebuddy/v1/responses/compact` |
| OpenAI Models | `GET /codebuddy/v1/models` |

Responses WebSocket 使用：

```text
ws://127.0.0.1:3080/codebuddy/v1/responses
```

可通过 `CODEBUDDY_EXTRA_BASE_URLS` 增加自定义上游，通过 `CODEBUDDY_MODEL_OVERRIDES` 为不同上游动态配置模型列表，并为每个模型声明 `tools`、`vision` 能力。

### GitHub Copilot

| 协议 | HTTP 入口 |
| --- | --- |
| Anthropic Messages | `POST /copilot/anthropic/v1/messages` |
| Anthropic Count Tokens | `POST /copilot/anthropic/v1/messages/count_tokens` |
| Anthropic Models | `GET /copilot/anthropic/v1/models` |
| OpenAI Chat Completions | `POST /copilot/v1/chat/completions` |
| OpenAI Responses | `POST /copilot/v1/responses` |
| Responses Compact | `POST /copilot/v1/responses/compact` |
| OpenAI Models | `GET /copilot/v1/models` |

Responses WebSocket 使用：

```text
ws://127.0.0.1:3080/copilot/v1/responses
```

Copilot 凭据按租户隔离。每条凭据可单独配置代理、TLS 校验、VS Code 版本、启用状态和活跃顺序。

## 使用统计和反馈

使用统计已经合并到 `/admin`：

| 页签 | 说明 |
| --- | --- |
| 用户排行 | 按日期范围查看用户调用、Token、缓存命中率、积分和状态 |
| 模型分析 | 按模型分析调用量、Token、缓存命中率和积分，便于优化缓存 |
| 用户趋势 | 查看新增用户、累计用户和日活用户趋势，可仅统计工作日 |
| 使用建议 | 管理员专用，基于采样数据生成重点人员 AI 使用建议 |

使用建议分析通过 `COACH_API_BASE`、`COACH_API_KEY`、`COACH_MODEL` 动态配置，不应在代码或文档中写死真实 Key。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务监听端口 | `3080` |
| `HOST` | 服务监听地址 | `0.0.0.0` |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `JWT_SECRET` | 会话签名密钥，生产必须配置 | 无 |
| `JWT_EXPIRES_IN` | 会话过期时间 | `8h` |
| `DB_DIALECT` | Sequelize 数据库方言 | `mysql` |
| `DB_HOST` | 数据库主机 | `127.0.0.1` |
| `DB_PORT` | 数据库端口 | `3306` |
| `DB_USER` | 数据库用户 | `root` |
| `DB_PASSWORD` | 数据库密码 | 空 |
| `DB_NAME` | 数据库名 | `claude_api_proxy` |
| `LDAP_SERVER` | LDAP 服务地址 | 无 |
| `LDAP_BIND_DN` | LDAP 绑定账号 | 无 |
| `LDAP_BIND_PASSWORD` | LDAP 绑定密码 | 无 |
| `LDAP_BASE_DN` | LDAP 搜索基准 DN | 无 |
| `LDAP_FILTER` | LDAP 用户过滤器，支持 `{userNo}` | `(sAMAccountName={userNo})` |
| `LDAP_PROBE_TIMEOUT_MS` | LDAP 启动探测超时 | `3000` |
| `LOCAL_ADMIN_USER` | 本地模式初始 superadmin 用户名 | 无 |
| `LOCAL_ADMIN_PASSWORD` | 本地模式初始 superadmin 密码 | 无 |
| `CODEBUDDY_REGION` | CodeBuddy 默认区域，`cn` 或 `intl` | `cn` |
| `CODEBUDDY_DEFAULT_BASE_URL` | CodeBuddy 默认上游地址 | 按区域选择 |
| `CODEBUDDY_CUSTOM_SITE_LABELS` | CodeBuddy 自定义/非官方上游在控制台中的显示标签映射 JSON，key 可写 host 或完整 URL | `{}` |
| `CODEBUDDY_EXTRA_BASE_URLS` | 额外 CodeBuddy 上游，逗号分隔 | 无 |
| `CODEBUDDY_MODEL_OVERRIDES` | 按 host 覆盖模型列表的 JSON，模型项支持 `id`、`name`、`tools`、`vision` | 无 |
| `STATS_IP_WHITELIST` | 统计页 IP 白名单，空为不限制 | 空 |
| `FEEDBACK_IP_WHITELIST` | 反馈页 IP 白名单，空为不限制 | 空 |
| `FEEDBACK_MAIL_FROM` | 反馈邮件发件人 | 空 |
| `FEEDBACK_MAIL_TO` | 反馈邮件收件人，逗号分隔 | 空 |
| `FEEDBACK_ATTACHMENTS_DIR` | 反馈附件目录 | `data/feedback-attachments` |
| `COACH_SAMPLE_RATE` | 使用建议采样比例 | `0.2` |
| `COACH_RETENTION_DAYS` | 使用建议样本保留天数 | `30` |
| `COACH_API_BASE` | 使用建议分析模型服务地址 | `http://127.0.0.1:3080/relay` |
| `COACH_API_KEY` | 使用建议分析 API Key | 空 |
| `COACH_MODEL` | 使用建议分析模型 | `glm-5` |
| `COACH_SANITIZE_PATTERNS` | 使用建议样本脱敏规则 | 空 |
| `CLUSTER_INTERNAL_SECRET` | 多 worker 内部同步密钥；多 worker 部署必须配置 | 空 |
| `CLUSTER_BASE_PORT` | 多 worker 起始端口 | `3081` |
| `CLUSTER_WORKER_COUNT` | 多 worker 数量 | `4` |
| `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_PATH` | 部署脚本 SSH 目标配置 | 示例占位 |

## 运行和部署

开发：

```bash
npm run dev
```

生产单实例：

```bash
npm start
```

PM2 单实例：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

PM2 多 worker：

```bash
pm2 start ecosystem.cluster.config.cjs
pm2 save
```

多 worker 默认使用 `3081-3084`，建议由 Nginx 或其他反向代理对外暴露统一入口。负载均衡说明见 [docs/ops/load-balancing.md](docs/ops/load-balancing.md)。

## 项目结构

```text
src/
  index.js                  服务入口
  server.js                 HTTP 和 WebSocket 路由分发
  routes/                   控制台、API、统计和反馈路由
  services/
    gateway/                租户、会话和 API Key 鉴权
    relay/                  Relay 上游管理和请求
    codebuddy/              CodeBuddy 凭证、配置和调用
    copilot/                GitHub/Copilot 授权和调用
    coach/                  使用建议采样和分析
    shared/                 本地账号、LDAP 探测、WS 和集群同步
  transformer/              Anthropic/OpenAI/Responses 格式转换
  templates/                控制台 HTML 模板
```

## License

MIT
