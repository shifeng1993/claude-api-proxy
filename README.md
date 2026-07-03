# Claude API Proxy

Claude API Proxy 是一个统一的 AI 服务控制台和协议代理。它在同一个控制台里管理 Relay、CodeBuddy、用户账号、使用统计和问题反馈，并在服务端完成 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Responses WebSocket 之间的协议转换。

控制台入口：

```text
http://127.0.0.1:3080/dashboard
```

登录成功后默认进入：

```text
/dashboard#/relay
```

旧入口 `/relayFE`、`/codebuddyFE` 会重定向到 `/dashboard`。

## 当前能力

| 能力 | 说明 |
| --- | --- |
| 统一 API Key | 每个用户/租户拥有一个 `sk-...` API Key，可访问自己已启用的服务 |
| Relay 中继 | 支持 OpenAI Chat、OpenAI Responses、Responses WebSocket、Anthropic 上游 |
| 多协议桥接 | Relay 客户端协议和上游协议可交叉组合，尽量保持流式边收边转 |
| 上游连通测试 | Relay 支持单个上游测试和批量测试，Responses WebSocket 上游会等待 `response.completed` 并设置超时 |
| CodeBuddy 代理 | 管理 CodeBuddy 凭证、自定义上游和模型覆盖 |
| 统一登录 | 启动时探测 LDAP；LDAP 不可用或未配置时自动切换为本地账号 |
| 用户管理 | superadmin 管理管理员和普通用户；admin 可查看同级管理员和普通用户，但只能操作普通用户 |
| 密码管理 | 管理员保留重置密码；本地用户可在右上角修改自己的密码；env 配置的 superadmin 不允许在页面改密码 |
| 使用统计 | 所有角色只查看当前登录用户自己的数据，支持月度统计和模型分析 |
| 问题反馈 | 用户可提交反馈；管理员可处理状态和附件 |

## 控制台页面

| 页面 | hash | 说明 |
| --- | --- | --- |
| Relay | `#/relay` | 管理 Relay 上游、协议、WS mode、模型映射、代理、TLS、单个/批量连通测试 |
| CodeBuddy | `#/codebuddy` | 管理 CodeBuddy 凭证、OAuth 授权、Claude Code 配置 |
| 使用统计 | `#/stats/{service}/monthly` | 查看当前用户自己的月度 API 调用和 Token 统计 |
| 模型分析 | `#/stats/{service}/model-cache` | 查看当前用户自己的模型调用、缓存命中率和积分消耗 |
| 问题反馈 | `#/feedback` | 提交、查看和处理反馈 |
| 用户管理 | `#/users` | 管理本地或 LDAP 登录过的用户记录和角色 |

`{service}` 可为 `relay`、`codebuddy`。

## 登录、角色和密码

- 本地模式下，`LOCAL_ADMIN_USER` 会同步为 `superadmin`。这个 env 配置的账号由环境变量管理，不会出现在用户列表中，也不能在页面修改自己的密码。
- LDAP 模式只有在 LDAP 必要环境变量齐全且 LDAP 服务可达时启用；否则自动回退到本地账号模式。
- `superadmin` 可以创建、编辑、删除管理员和普通用户，但不能操作 env 配置的 superadmin。
- `admin` 可以进入用户管理，能看到同级管理员和普通用户，看不到上级 superadmin；同级管理员只读，普通用户可操作。
- 管理员重置密码用于用户忘记密码的场景；用户自己修改密码在控制台右上角。
- 登录页的“忘记密码”只提示联系管理员，不展示电话、邮箱等联系方式。

## 快速启动

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell：

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

## Relay 协议支持

Relay 客户端入口支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 和 Responses WebSocket。活跃上游支持四类协议：

| 客户端入口 | 上游 `openai` | 上游 `responses` | 上游 `responses_ws` | 上游 `anthropic` |
| --- | --- | --- | --- | --- |
| Anthropic Messages | Anthropic -> Chat | Anthropic -> Responses | Anthropic -> Responses WS | 直通 |
| OpenAI Chat | 直通 | Chat -> Responses | Chat -> Responses WS | Chat -> Anthropic |
| OpenAI Responses | Responses -> Chat | 直通 | Responses -> Responses WS | Responses -> Anthropic |
| Responses WebSocket | WS -> Chat | WS -> Responses HTTP | WS 直通或复用 | WS -> Anthropic |

说明：

- `responses_ws` 上游默认使用 `ctx_pool`，会复用上游 WebSocket 连接，并尽量接上 `previous_response_id`。
- 旧配置里的 `passthrough` 会按 `ctx_pool` 处理，避免绕过 relay conversation state 后破坏协议切换。
- Responses input 会去掉历史 output item/part id 引用，并在最后一条 assistant input 上保留 `partial: true`，用于兼容火山引擎等 Responses 上游的续写要求。
- Relay 会维护短期内存会话状态，用于 Responses/Responses WebSocket 增量请求转到 Chat 或 Anthropic 上游时恢复完整上下文。状态按租户和会话隔离，当前推荐单实例部署；默认保留 24 小时并定期清理，服务重启后内存状态会丢失，未来重新扩容时再引入共享存储。
- Anthropic `messages/count_tokens` 只有 Anthropic 上游可直通；其他上游会用本地估算返回。
- 模型名默认原样透传。需要改名时，在 Relay 上游配置里使用模型映射。
- 单个上游和批量上游测试共用同一套测试逻辑；`responses_ws` 测试会等待完成事件并受 `RELAY_UPSTREAM_TEST_TIMEOUT_MS` 控制。

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

Relay 上游字段包括 `protocol`、`ws_mode`、`base_url`、`api_key`、`proxy`、`skip_tls_verify`、`model_map`、启用状态和活跃顺序。代理支持 `http://`、`https://`、`socks://`、`socks4://`、`socks5://`。

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

## 使用统计和反馈

使用统计已经合并到 `/dashboard`：

| 页签 | 说明 |
| --- | --- |
| 月度统计 | 按月份查看当前用户自己的 API 调用、输入 Tokens、输出 Tokens、总 Tokens |
| 模型分析 | 按日期范围查看当前用户自己的模型调用量、缓存命中率、Token 和积分消耗 |

使用统计 API 允许已登录用户访问，但所有角色都只返回当前用户自己的租户数据。管理员和超级管理员不会获得全局统计或他人统计。

反馈页面允许用户提交 BUG、功能建议或其他问题，可附带附件。管理员可以处理反馈状态、查看详情和删除反馈。

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务监听端口 | `3080` |
| `HOST` | 服务监听地址 | `0.0.0.0` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 默认上游 HTTP(S) 代理；单个上游/凭据配置的代理优先级更高 | 空 |
| `LOG_LEVEL` | 日志级别 | `INFO` |
| `JWT_SECRET` | 会话签名密钥，生产必须配置 | 无 |
| `JWT_EXPIRES_IN` | 会话过期时间 | `8h` |
| `SESSION_COOKIE_DOMAIN` / `COOKIE_DOMAIN` | 控制台登录 Cookie 域名，留空时使用当前 host | 空 |
| `DASHBOARD_CORS_ORIGINS` | 控制台接口 CORS 允许来源，逗号分隔 | 空 |
| `DB_DIALECT` | Sequelize 数据库方言 | `mysql` |
| `DB_HOST` | 数据库主机 | `127.0.0.1` |
| `DB_PORT` | 数据库端口 | `3306` |
| `DB_USER` | 数据库用户 | 无 |
| `DB_PASSWORD` | 数据库密码 | 无 |
| `DB_NAME` | 数据库名 | `claude_api_proxy` |
| `LOCAL_ADMIN_USER` | 本地模式初始 superadmin 用户名 | 无 |
| `LOCAL_ADMIN_PASSWORD` | 本地模式初始 superadmin 密码 | 无 |
| `LDAP_SERVER` | LDAP 服务地址 | 无 |
| `LDAP_BIND_DN` | LDAP 绑定账号 | 无 |
| `LDAP_BIND_PASSWORD` | LDAP 绑定密码 | 无 |
| `LDAP_BASE_DN` | LDAP 搜索基准 DN | 无 |
| `LDAP_FILTER` | LDAP 用户过滤器，支持 `{userNo}` | `(sAMAccountName={userNo})` |
| `LDAP_PROBE_TIMEOUT_MS` | LDAP 启动探测超时 | `3000` |
| `LDAP_RELAY_ENABLED` | 是否保留 Relay API 鉴权 | `true` |
| `CODEBUDDY_REGION` | CodeBuddy 默认区域，`cn` 或 `intl` | `cn` |
| `CODEBUDDY_DEFAULT_BASE_URL` | CodeBuddy 默认上游地址 | 按区域选择 |
| `CODEBUDDY_CUSTOM_SITE_LABELS` | CodeBuddy 自定义/非官方上游在控制台中的显示标签映射 JSON，key 可写 host 或完整 URL | `{}` |
| `CODEBUDDY_EXTRA_BASE_URLS` | 额外 CodeBuddy 上游，逗号分隔 | 无 |
| `CODEBUDDY_MODEL_OVERRIDES` | 按 host 覆盖模型列表的 JSON，模型项支持 `id`、`name`、`tools`、`vision` | 无 |
| `CODEBUDDY_DEFAULT_USER_ID` | CodeBuddy 默认用户 ID 兜底 | `unknown` |
| `RELAY_UPSTREAM_TEST_TIMEOUT_MS` | Relay 上游连通测试超时 | `30000` |
| `RELAY_CONVERSATION_STATE_TTL_MS` | Relay 内存会话状态保留时间 | `86400000` |
| `RELAY_CONVERSATION_STATE_CLEANUP_INTERVAL_MS` | Relay 内存会话状态清理间隔 | `300000` |
| `RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES` | 每个 Relay 会话保留的 Chat messages 上限，超出后裁剪旧上下文 | `200` |
| `RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS` | 每个 Relay 会话保留的 canonical turns 上限，超出后裁剪旧上下文 | `200` |
| `RELAY_CONVERSATION_STATE_MAX_CONVERSATIONS` | Relay 会话总数上限，`0` 表示不按总数驱逐 | `0` |
| `RELAY_CONVERSATION_STATE_MAX_CONVERSATIONS_PER_TENANT` | 单租户 Relay 会话数上限，`0` 表示不按租户驱逐 | `0` |
| `RELAY_CONVERSATION_STATE_MAX_CONVERSATION_BYTES` | 单个 Relay 会话近似字节上限，超出后驱逐该会话，`0` 表示关闭 | `0` |
| `RELAY_CONVERSATION_STATE_MAX_TOTAL_BYTES` | Relay 会话存储总近似字节上限，超出后按最旧会话驱逐，`0` 表示关闭 | `0` |
| `RELAY_RESPONSES_INPUT_ITEMS_LIMIT` | Responses 输入 items 重放上限，用于避免历史无限增长 | `500` |
| `RESPONSES_WS_MODE` / `RELAY_RESPONSES_WS_MODE` | Relay Responses WebSocket 默认模式 | `ctx_pool` |
| `FEEDBACK_MAIL_FROM` | 反馈邮件发件人 | 空 |
| `FEEDBACK_MAIL_TO` | 反馈邮件收件人，逗号分隔 | 空 |
| `FEEDBACK_ATTACHMENTS_DIR` | 反馈附件目录 | `data/feedback-attachments` |
| `FEEDBACK_ATTACHMENT_MAX_SIZE` | 单个反馈附件最大字节数 | `5242880` |
| `FEEDBACK_MAX_ATTACHMENTS` | 单次反馈最多附件数 | `5` |
| `DEPLOY_HOST` / `DEPLOY_PORT` / `DEPLOY_USER` / `DEPLOY_PATH` | 部署脚本 SSH 目标配置 | 示例占位 |
| `DEPLOY_PASSWORD` | 部署脚本 SSH 密码；也可用 `--password=` 命令行参数或交互输入 | 空 |
| `DEPLOY_PM2_NAME` | 部署脚本 PM2 应用名 | `ClaudeApiProxy` |
| `DEPLOY_HEALTH_URL` | 部署脚本健康检查地址 | `http://localhost:3080/health` |
| `PAYLOAD_INTERCEPT_ENABLED` | 调试请求拦截开关，生产不建议开启 | `false` |
| `PAYLOAD_INTERCEPT_DIR` | 调试请求拦截文件保存目录 | `.debug-payloads` |
| `PAYLOAD_INTERCEPT_MAX_FILES` | 每个拦截通道最多保留文件数 | `500` |
| `PAYLOAD_INTERCEPT_PREFIX_CHARS` | 调试文件名前缀 hash 的输入字符数 | `3000` |

用户排行、用户趋势等旧统计页已从控制台移除，统计页现在只保留当前用户可查看的月度用量和模型缓存分析。旧的隐私采样分析功能已移除，服务端不会再保存请求/响应样本用于分析。

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

当前推荐单实例部署。Relay 会在进程内维护短期 conversation state，用于补全 Responses/WS 增量请求再转换到 Chat Completions 或 Anthropic；单实例可以保证这些状态稳定命中。默认状态保留 24 小时，可通过 `RELAY_CONVERSATION_STATE_TTL_MS` 调整。`MAX_CHAT_MESSAGES` 和 `MAX_CANONICAL_TURNS` 会限制单会话历史长度；会话总数、单租户数量和近似字节预算默认关闭，可在小内存环境显式开启以按最旧会话驱逐。

## 测试

```bash
npm test
```

当前测试覆盖协议转换、Responses WebSocket、使用统计隔离、用户角色、密码修改、上游连通测试和控制台模板语法。

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
    shared/                 本地账号、LDAP 探测和 WS 支持
  protocol-engine/           协议转换核心和 Canonical Session/Stream 渲染
  templates/                控制台 HTML 模板
```

## 架构边界

协议转换核心、gateway、产品接入服务与路由层的依赖边界见 [docs/architecture-boundaries.md](docs/architecture-boundaries.md)。新增客户端、Provider 或协议通路时，优先按该文档判断代码归属。

## License

MIT
