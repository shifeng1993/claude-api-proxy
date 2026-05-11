# Copilot FE 管理面板实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Copilot 模块添加 FE 管理面板，实现 GitHub 设备码认证、API Key 鉴权、用量统计、代理配置，与 CodeBuddy 管理面板功能对齐。

**Architecture:** 完全复用 CodeBuddy 的架构模式——新建 `copilot-store.js` 统一管理 API Key/用量/代理配置，拆分 `auth.js` 认证流程从控制台迁移到 FE，新增 `copilot-frontend.js` 路由和 `copilot-admin.html` 模板。

**Tech Stack:** Node.js 原生 HTTP 服务，纯 HTML/CSS/JS 前端（无框架），与现有 CodeBuddy/Relay 管理面板技术栈一致。

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/services/copilot/copilot-store.js` | API Key 管理、用量统计、代理配置、封装 copilotState |
| 修改 | `src/services/copilot/auth.js` | 拆分认证流程：startDeviceAuth + pollDeviceAuth |
| 修改 | `src/routes/copilot.js` | 接入 API Key 鉴权 + 用量统计，去掉控制台认证 |
| 新增 | `src/routes/copilot-frontend.js` | FE 路由：认证、凭证、API Key、统计、代理 |
| 新增 | `src/templates/copilot-admin.html` | 管理面板 HTML |
| 修改 | `src/server.js` | 注册 `/copilotFE` 路由分发 |
| 修改 | `src/index.js` | 移除自动认证，改启动提示 |

---

### Task 1: 创建 copilot-store.js

**Files:**
- Create: `src/services/copilot/copilot-store.js`
- Reference: `src/services/codebuddy/credential-store.js`（同构模板）
- Reference: `src/services/relay/relay-store.js`（同构模板）
- Reference: `src/services/copilot/state.js`（被封装的底层）

- [ ] **Step 1: 创建 copilot-store.js**

创建 `src/services/copilot/copilot-store.js`，完全参照 `credential-store.js` 的结构，职责包括：

1. **API Key 管理**：生成 `sk-copilot-xxx`，SHA256 哈希存储，支持重新生成
2. **用量统计**：累计统计 + 可重置自定义统计 + 每日统计（保留3个月）+ 脏计数刷盘
3. **代理配置**：首次从环境变量读取，持久化到 `.copilot/proxy.json`，可 FE 修改
4. **凭证管理**：封装 `copilotState`，暴露 `isAuthenticated()`、`getUserInfo()`、`getTokenStatus()`

```javascript
/**
 * Copilot 单租户存储管理器
 * 管理 API Key 鉴权、用量统计、代理配置
 * 同构 credential-store.js / relay-store.js
 * @module services/copilot/copilot-store
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {randomBytes, createHash} from 'crypto';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {copilotState} from './state.js';

const COPILOT_DIR = '.copilot';
const API_KEY_FILE = 'api_key.json';
const USAGE_FILE = 'usage.json';
const PROXY_FILE = 'proxy.json';

class CopilotStore {
    constructor() {
        this.baseDir = join(process.cwd(), COPILOT_DIR);
        this.apiKeyFile = join(this.baseDir, API_KEY_FILE);
        this.usageFile = join(this.baseDir, USAGE_FILE);
        this.proxyFile = join(this.baseDir, PROXY_FILE);

        this.apiKey = null;
        this.apiKeyHash = null;
        this.apiKeyPrefix = null;

        // Usage tracking
        this.apiCallCount = 0;
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.customApiCallCount = 0;
        this.customInputTokens = 0;
        this.customOutputTokens = 0;
        this.dirtyCount = 0;
        this.DIRTY_FLUSH_THRESHOLD = 10;

        // Proxy config
        this.httpProxy = null;
        this.httpsProxy = null;

        this._init();
    }

    _init() {
        if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, {recursive: true});
        this._loadApiKey();
        this._loadUsage();
        this._loadProxy();
    }

    // ==================== API Key ====================

    _loadApiKey() {
        if (existsSync(this.apiKeyFile)) {
            try {
                const data = JSON.parse(readFileSync(this.apiKeyFile, 'utf8'));
                this.apiKeyHash = data.api_key_hash;
                this.apiKeyPrefix = data.api_key_prefix;
                this.apiKey = data.api_key_plain || null;
            } catch (err) {
                logger.error('Failed to load Copilot API key file:', err.message);
            }
        }
        if (!this.apiKeyHash) {
            this._generateApiKey();
        }
    }

    _generateApiKey() {
        const key = 'sk-copilot-' + randomBytes(16).toString('hex');
        this.apiKey = key;
        this.apiKeyHash = createHash('sha256').update(key).digest('hex');
        this.apiKeyPrefix = key.substring(0, 12) + '****' + key.substring(key.length - 4);
        this._saveApiKey();
        logger.info(`Generated Copilot API Key: ${key}`);
        logger.info('Please save this key, it will not be shown again.');
    }

    _saveApiKey() {
        writeFileSync(this.apiKeyFile, JSON.stringify({
            api_key_hash: this.apiKeyHash,
            api_key_prefix: this.apiKeyPrefix,
            api_key_plain: this.apiKey,
            created_at: new Date().toISOString()
        }, null, 2), 'utf8');
    }

    authenticate(apiKey) {
        const hash = createHash('sha256').update(apiKey).digest('hex');
        return hash === this.apiKeyHash;
    }

    getApiKeyInfo() {
        return {
            prefix: this.apiKeyPrefix,
            hash: this.apiKeyHash,
            key: this.apiKey,
            apiKeyPlain: this.apiKey
        };
    }

    regenerateApiKey() {
        this._generateApiKey();
        return this.apiKey;
    }

    // ==================== Usage Stats ====================

    _loadUsage() {
        if (existsSync(this.usageFile)) {
            try {
                const data = JSON.parse(readFileSync(this.usageFile, 'utf8'));
                this.apiCallCount = data.api_call_count || 0;
                this.inputTokens = data.input_tokens || 0;
                this.outputTokens = data.output_tokens || 0;
                this.customApiCallCount = data.custom_api_call_count || 0;
                this.customInputTokens = data.custom_input_tokens || 0;
                this.customOutputTokens = data.custom_output_tokens || 0;
            } catch {}
        }
    }

    _saveUsage() {
        writeFileSync(this.usageFile, JSON.stringify({
            api_call_count: this.apiCallCount,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            custom_api_call_count: this.customApiCallCount,
            custom_input_tokens: this.customInputTokens,
            custom_output_tokens: this.customOutputTokens
        }, null, 2), 'utf8');
        this.dirtyCount = 0;
    }

    incrementApiCallCount() {
        this.apiCallCount++;
        this.customApiCallCount++;
        this.dirtyCount++;
        if (this.dirtyCount >= this.DIRTY_FLUSH_THRESHOLD) this._saveUsage();
    }

    incrementTokenUsage(inputTokens, outputTokens) {
        this.inputTokens += inputTokens || 0;
        this.outputTokens += outputTokens || 0;
        this.customInputTokens += inputTokens || 0;
        this.customOutputTokens += outputTokens || 0;
        this.dirtyCount++;
        if (this.dirtyCount >= this.DIRTY_FLUSH_THRESHOLD) this._saveUsage();
    }

    flushApiCallCounts() {
        if (this.dirtyCount > 0) this._saveUsage();
    }

    getUsageStats() {
        return {
            api_call_count: this.apiCallCount,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            custom_api_call_count: this.customApiCallCount,
            custom_input_tokens: this.customInputTokens,
            custom_output_tokens: this.customOutputTokens
        };
    }

    resetCustomStats() {
        this.customApiCallCount = 0;
        this.customInputTokens = 0;
        this.customOutputTokens = 0;
        this._saveUsage();
    }

    // ==================== Daily Usage ====================

    recordDailyUsage(inputTokens, outputTokens) {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        let dailyData = {};
        if (existsSync(dailyFile)) {
            try { dailyData = JSON.parse(readFileSync(dailyFile, 'utf8')); } catch {}
        }
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dayKey = String(now.getDate()).padStart(2, '0');
        if (!dailyData[monthKey]) dailyData[monthKey] = {};
        if (!dailyData[monthKey][dayKey]) {
            dailyData[monthKey][dayKey] = {api_calls: 0, input_tokens: 0, output_tokens: 0};
        }
        dailyData[monthKey][dayKey].api_calls++;
        dailyData[monthKey][dayKey].input_tokens += inputTokens || 0;
        dailyData[monthKey][dayKey].output_tokens += outputTokens || 0;
        const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
        for (const key of Object.keys(dailyData)) {
            if (key < cutoffKey) delete dailyData[key];
        }
        writeFileSync(dailyFile, JSON.stringify(dailyData, null, 2), 'utf8');
    }

    getDailyUsage(month) {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        if (!existsSync(dailyFile)) return {};
        try {
            const dailyData = JSON.parse(readFileSync(dailyFile, 'utf8'));
            if (month) return dailyData[month] || {};
            return dailyData;
        } catch { return {}; }
    }

    getAvailableMonths() {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        if (!existsSync(dailyFile)) return [];
        try {
            const dailyData = JSON.parse(readFileSync(dailyFile, 'utf8'));
            return Object.keys(dailyData).sort().reverse().slice(0, 3);
        } catch { return []; }
    }

    // ==================== Proxy Config ====================

    _loadProxy() {
        if (existsSync(this.proxyFile)) {
            try {
                const data = JSON.parse(readFileSync(this.proxyFile, 'utf8'));
                this.httpProxy = data.http_proxy || null;
                this.httpsProxy = data.https_proxy || null;
                return;
            } catch {}
        }
        // 首次从环境变量读取
        this.httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || null;
        this.httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
        this._saveProxy();
    }

    _saveProxy() {
        writeFileSync(this.proxyFile, JSON.stringify({
            http_proxy: this.httpProxy,
            https_proxy: this.httpsProxy,
            updated_at: new Date().toISOString()
        }, null, 2), 'utf8');
    }

    getProxyConfig() {
        return {http_proxy: this.httpProxy, https_proxy: this.httpsProxy};
    }

    updateProxyConfig(httpProxy, httpsProxy) {
        this.httpProxy = httpProxy || null;
        this.httpsProxy = httpsProxy || null;
        this._saveProxy();
        logger.info(`Proxy config updated: http=${this.httpProxy}, https=${this.httpsProxy}`);
    }

    // ==================== Credential Info (封装 copilotState) ====================

    isAuthenticated() {
        return !!copilotState.githubToken;
    }

    getUserInfo() {
        return copilotState.userInfo;
    }

    getTokenStatus() {
        return {
            hasGithubToken: !!copilotState.githubToken,
            hasCopilotToken: !!copilotState.copilotToken,
            copilotTokenExpired: copilotState.isCopilotTokenExpired(),
            accountType: copilotState.accountType,
            vsCodeVersion: copilotState.vsCodeVersion
        };
    }
}

export const copilotStore = new CopilotStore();
```

- [ ] **Step 2: 验证文件可被正常导入**

Run: `cd /Users/shifeng/claude-api-proxy && node -e "import('./src/services/copilot/copilot-store.js').then(m => console.log('copilotStore loaded, apiKey:', m.copilotStore.getApiKeyInfo().prefix))"`
Expected: 输出 `copilotStore loaded, apiKey: sk-copilot-****` 格式

- [ ] **Step 3: Commit**

```bash
git add src/services/copilot/copilot-store.js
git commit -m "feat: add copilot-store with API Key, usage stats, proxy config"
```

---

### Task 2: 修改 auth.js — 拆分认证流程

**Files:**
- Modify: `src/services/copilot/auth.js`

- [ ] **Step 1: 重写 auth.js**

将 `authenticateGitHub()` 拆分为 `startDeviceAuth()` 和 `pollDeviceAuth()`，去掉所有 `console.log` 输出。保留 `ensureCopilotToken()` 和 `clearAuthentication()`。

```javascript
/**
 * Copilot 认证工具
 * @module services/copilot/auth
 */

import { getDeviceCode, pollAccessToken, getUser, getCopilotToken } from './github-api.js';
import { copilotState } from './state.js';
import logger from '../../utils/logger.js';

/**
 * 启动 GitHub 设备码认证，返回设备码信息供 FE 展示
 * @returns {Promise<{device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number}>}
 */
export async function startDeviceAuth() {
    logger.info('Starting GitHub device authentication flow...');

    const deviceCodeData = await getDeviceCode();

    logger.info(`Device code generated: ${deviceCodeData.user_code}`);
    logger.info(`Verification URI: ${deviceCodeData.verification_uri}`);

    return deviceCodeData;
}

/**
 * 轮询 GitHub 等待用户完成设备码授权
 * 授权成功后自动保存 GitHub token 和用户信息到 copilotState
 * @param {string} deviceCode - 设备代码
 * @param {number} interval - 轮询间隔（秒）
 * @param {number} expiresIn - 过期时间（秒）
 * @returns {Promise<{githubToken: string, userInfo: object}>}
 */
export async function pollDeviceAuth(deviceCode, interval, expiresIn) {
    logger.info('Polling for GitHub device authorization...');

    const tokenData = await pollAccessToken(deviceCode, interval, expiresIn);

    const githubToken = tokenData.access_token;
    copilotState.saveGithubToken(githubToken);

    const userInfo = await getUser(githubToken, copilotState.vsCodeVersion);
    copilotState.saveUserInfo(userInfo);

    logger.info(`Successfully authenticated as ${userInfo.login}`);

    return { githubToken, userInfo };
}

/**
 * 刷新 Copilot token
 * @param {string} [proxyUrl] - 代理地址
 * @returns {Promise<string>}
 */
export async function refreshCopilotToken(proxyUrl) {
    if (!copilotState.githubToken) {
        throw new Error('GitHub token not found. Please authenticate first.');
    }

    logger.info('Refreshing Copilot token...');

    const tokenData = await getCopilotToken(
        copilotState.githubToken,
        copilotState.vsCodeVersion,
        proxyUrl
    );

    copilotState.saveCopilotToken(tokenData.token, tokenData.expires_at);
    logger.info('Successfully refreshed Copilot token');

    return tokenData.token;
}

/**
 * 确保有有效的 Copilot token
 * @param {string} [proxyUrl] - 代理地址
 * @returns {Promise<string>}
 */
export async function ensureCopilotToken(proxyUrl) {
    if (!copilotState.githubToken) {
        throw new Error('Not authenticated. Please visit /copilotFE to authenticate.');
    }

    if (copilotState.isCopilotTokenExpired()) {
        await refreshCopilotToken(proxyUrl);
    }

    return copilotState.copilotToken;
}

/**
 * 检查是否已认证
 * @returns {boolean}
 */
export function isAuthenticated() {
    return !!copilotState.githubToken;
}

/**
 * 清除认证状态
 */
export function clearAuthentication() {
    copilotState.clearState();
    logger.info('Authentication cleared');
}
```

- [ ] **Step 2: 验证语法正确**

Run: `cd /Users/shifeng/claude-api-proxy && node --check src/services/copilot/auth.js`
Expected: 无输出（语法正确）

- [ ] **Step 3: Commit**

```bash
git add src/services/copilot/auth.js
git commit -m "refactor: split copilot auth into startDeviceAuth + pollDeviceAuth, remove console output"
```

---

### Task 3: 修改 copilot.js — 接入 API Key 鉴权 + 用量统计

**Files:**
- Modify: `src/routes/copilot.js`

- [ ] **Step 1: 在 copilot.js 顶部导入 copilotStore 并添加 API Key 鉴权函数**

在文件顶部的 import 区域添加：

```javascript
import {copilotStore} from '../services/copilot/copilot-store.js';
```

添加 API Key 鉴权函数（放在工具函数区域）：

```javascript
/**
 * API Key 鉴权
 */
function authenticateRequest(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return false;
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    return copilotStore.authenticate(token);
}
```

- [ ] **Step 2: 修改 authenticateAndGetToken 函数**

替换现有的 `authenticateAndGetToken` 函数，加入 API Key 校验：

```javascript
async function authenticateAndGetToken(req) {
    // API Key 鉴权
    if (!authenticateRequest(req)) {
        return {error: {status: 401, message: 'Invalid API Key. Check your API key or visit /copilotFE.'}};
    }

    // Copilot 认证检查
    if (!isAuthenticated()) {
        return {error: {status: 401, message: 'Not authenticated. Please visit /copilotFE to authenticate with GitHub.'}};
    }

    try {
        const proxyUrl = copilotStore.getProxyConfig().https_proxy || copilotStore.getProxyConfig().http_proxy;
        const copilotToken = await ensureCopilotToken(proxyUrl);
        return {copilotToken};
    } catch (error) {
        return {error: {status: 503, message: error.message}};
    }
}
```

- [ ] **Step 3: 删除 AUTO_AUTH 常量和 ensureAuthenticated 函数**

删除以下代码：

```javascript
// 删除这行
const AUTO_AUTH = true;

// 删除整个 ensureAuthenticated 函数
async function ensureAuthenticated() { ... }
```

- [ ] **Step 4: 修改 extractProxyFromHeaders，优先从 copilotStore 读取代理**

替换现有的 `extractProxyFromHeaders` 函数：

```javascript
function extractProxyFromHeaders(req) {
    // 优先从 store 读取代理配置
    const storeProxy = copilotStore.getProxyConfig().https_proxy || copilotStore.getProxyConfig().http_proxy;
    if (storeProxy) return storeProxy;

    // 兼容：从请求头读取（仅本地请求）
    const proxy = req.headers['x-copilot-proxy'];
    if (!proxy) return undefined;
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        return proxy;
    }
    return undefined;
}
```

- [ ] **Step 5: 在 OpenAI 流式响应中添加用量统计**

在 `handleOpenAIChatCompletions` 函数中，在流式响应的 `response.body.on('end', ...)` 回调里，添加用量记录。找到现有的 stream 处理代码（已有 `streamInputTokens` 和 `streamOutputTokens` 变量），在 `res.end()` 之前添加：

```javascript
// 记录用量
if (streamInputTokens > 0 || streamOutputTokens > 0) {
    copilotStore.incrementApiCallCount();
    copilotStore.incrementTokenUsage(streamInputTokens, streamOutputTokens);
    copilotStore.recordDailyUsage(streamInputTokens, streamOutputTokens);
} else {
    copilotStore.incrementApiCallCount();
    const estimated = estimateMessageTokens(openAIPayload.messages || []);
    copilotStore.incrementTokenUsage(estimated, 0);
    copilotStore.recordDailyUsage(estimated, 0);
}
```

- [ ] **Step 6: 在非流式响应中添加用量统计**

在 `handleOpenAIChatCompletions` 的非流式分支中，`sendJson(res, 200, parsed)` 之前添加：

```javascript
const inputTokens = parsed.usage?.prompt_tokens || 0;
const outputTokens = parsed.usage?.completion_tokens || 0;
copilotStore.incrementApiCallCount();
if (inputTokens > 0 || outputTokens > 0) {
    copilotStore.incrementTokenUsage(inputTokens, outputTokens);
    copilotStore.recordDailyUsage(inputTokens, outputTokens);
} else {
    const estimated = estimateMessageTokens(openAIPayload.messages || []);
    copilotStore.incrementTokenUsage(estimated, 0);
    copilotStore.recordDailyUsage(estimated, 0);
}
```

- [ ] **Step 7: 在 Anthropic 流式响应中添加同样的用量统计**

在 `handleAnthropicMessages` 中，找到流式响应 `response.body.on('end', ...)` 回调，在 `res.end()` 之前添加同样的用量记录逻辑（和 Step 5 相同）。

- [ ] **Step 8: 在 Anthropic 非流式响应中添加用量统计**

在 `handleAnthropicMessages` 的非流式分支中，`sendJson(res, 200, anthropicResponse)` 之前添加同样的用量记录逻辑（和 Step 6 相同）。

- [ ] **Step 9: Commit**

```bash
git add src/routes/copilot.js
git commit -m "feat: add API Key auth and usage tracking to copilot routes"
```

---

### Task 4: 创建 copilot-frontend.js — FE 路由

**Files:**
- Create: `src/routes/copilot-frontend.js`
- Reference: `src/routes/codebuddy-frontend.js`（同构模板）
- Reference: `src/routes/relay-frontend.js`（同构模板）

- [ ] **Step 1: 创建 copilot-frontend.js**

```javascript
/**
 * Copilot 前端管理界面路由
 * 提供 Web UI 用于 GitHub 认证、API Key 管理、用量统计、代理配置
 * @module routes/copilot-frontend
 */

import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import logger from '../utils/logger.js';
import {copilotStore} from '../services/copilot/copilot-store.js';
import {startDeviceAuth, pollDeviceAuth, clearAuthentication, isAuthenticated} from '../services/copilot/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

function readTemplate(name) {
    return readFileSync(join(templatesDir, name), 'utf8');
}

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * 整体状态
 */
function handleStatus(req, res) {
    const apiInfo = copilotStore.getApiKeyInfo();
    const usage = copilotStore.getUsageStats();
    const tokenStatus = copilotStore.getTokenStatus();
    const userInfo = copilotStore.getUserInfo();
    const proxyConfig = copilotStore.getProxyConfig();
    sendJson(res, 200, {
        authenticated: isAuthenticated(),
        userInfo,
        tokenStatus,
        apiKeyPrefix: apiInfo.prefix,
        apiKeyPlain: apiInfo.apiKeyPlain,
        usage,
        proxy: proxyConfig
    });
}

/**
 * 启动 GitHub 设备码认证
 */
async function handleAuthStart(req, res) {
    try {
        const deviceData = await startDeviceAuth();
        sendJson(res, 200, {
            success: true,
            device_code: deviceData.device_code,
            user_code: deviceData.user_code,
            verification_uri: deviceData.verification_uri,
            expires_in: deviceData.expires_in,
            interval: deviceData.interval || 5
        });
    } catch (error) {
        logger.error('Failed to start device auth:', error);
        sendJson(res, 500, {success: false, error: error.message});
    }
}

/**
 * 轮询认证状态
 */
async function handleAuthPoll(req, res) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);
        const {device_code, interval, expires_in} = data;

        if (!device_code) {
            return sendJson(res, 400, {error: 'missing device_code'});
        }

        const result = await pollDeviceAuth(device_code, interval || 5, expires_in || 900);
        sendJson(res, 200, {
            status: 'success',
            message: '认证成功！',
            user_info: {
                login: result.userInfo.login,
                name: result.userInfo.name,
                avatar_url: result.userInfo.avatar_url
            }
        });
    } catch (error) {
        // 区分"等待授权"和"真正失败"
        const msg = error.message || '';
        if (msg.includes('authorization_pending') || msg.includes('slow_down')) {
            sendJson(res, 200, {status: 'pending', message: '等待用户授权...'});
        } else if (msg.includes('expired')) {
            sendJson(res, 200, {status: 'expired', message: '设备码已过期，请重新发起认证'});
        } else {
            logger.error('Auth poll error:', error);
            sendJson(res, 500, {status: 'error', message: error.message});
        }
    }
}

/**
 * 清除认证
 */
function handleAuthClear(req, res) {
    clearAuthentication();
    sendJson(res, 200, {message: '认证已清除'});
}

/**
 * 获取凭证信息
 */
function handleCredentials(req, res) {
    const tokenStatus = copilotStore.getTokenStatus();
    const userInfo = copilotStore.getUserInfo();
    sendJson(res, 200, {tokenStatus, userInfo});
}

/**
 * 获取 API Key 信息
 */
function handleApiKey(req, res) {
    const info = copilotStore.getApiKeyInfo();
    sendJson(res, 200, {prefix: info.prefix, apiKeyPlain: info.apiKeyPlain});
}

/**
 * 重新生成 API Key
 */
function handleRegenerateApiKey(req, res) {
    try {
        const newKey = copilotStore.regenerateApiKey();
        sendJson(res, 200, {
            message: 'API Key 已重新生成，新 Key 仅显示一次！',
            api_key: newKey
        });
    } catch (error) {
        logger.error('Failed to regenerate Copilot API Key:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 获取每日用量
 */
function handleDailyStats(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const month = urlObj.searchParams.get('month') || '';
    if (!month) {
        return sendJson(res, 400, {error: '缺少 month 参数'});
    }
    const dailyData = copilotStore.getDailyUsage(month);
    sendJson(res, 200, {month, data: dailyData});
}

/**
 * 获取代理配置
 */
function handleProxyGet(req, res) {
    sendJson(res, 200, copilotStore.getProxyConfig());
}

/**
 * 更新代理配置
 */
async function handleProxyUpdate(req, res) {
    try {
        const body = await readRequestBody(req);
        const data = JSON.parse(body);
        copilotStore.updateProxyConfig(data.http_proxy, data.https_proxy);
        sendJson(res, 200, {message: '代理配置已更新', ...copilotStore.getProxyConfig()});
    } catch (error) {
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 管理面板 HTML
 */
function serveAdminPage(res) {
    const html = readTemplate('copilot-admin.html');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}

/**
 * 主路由处理函数
 */
export async function routeCopilotFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // 主页面
    if (pathname === '/copilotFE' || pathname === '/copilotFE/') {
        return serveAdminPage(res);
    }

    // 状态
    if (pathname === '/copilotFE/status' && method === 'GET') {
        return handleStatus(req, res);
    }

    // 认证
    if (pathname === '/copilotFE/auth/start' && method === 'GET') {
        return handleAuthStart(req, res);
    }
    if (pathname === '/copilotFE/auth/poll' && method === 'POST') {
        return handleAuthPoll(req, res);
    }
    if (pathname === '/copilotFE/auth/clear' && method === 'POST') {
        return handleAuthClear(req, res);
    }

    // 凭证
    if (pathname === '/copilotFE/credentials' && method === 'GET') {
        return handleCredentials(req, res);
    }

    // API Key
    if (pathname === '/copilotFE/apikey' && method === 'GET') {
        return handleApiKey(req, res);
    }
    if (pathname === '/copilotFE/apikey/regenerate' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    // 统计
    if (pathname === '/copilotFE/stats/refresh' && method === 'POST') {
        copilotStore.flushApiCallCounts();
        return sendJson(res, 200, {message: '数据已刷新'});
    }
    if (pathname === '/copilotFE/stats/custom-reset' && method === 'POST') {
        copilotStore.resetCustomStats();
        return sendJson(res, 200, {message: '自定义统计数据已重置'});
    }
    if (pathname === '/copilotFE/stats/daily' && method === 'GET') {
        return handleDailyStats(req, res);
    }

    // 代理
    if (pathname === '/copilotFE/proxy' && method === 'GET') {
        return handleProxyGet(req, res);
    }
    if (pathname === '/copilotFE/proxy' && method === 'POST') {
        return handleProxyUpdate(req, res);
    }

    // 404
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Not found'}));
}
```

- [ ] **Step 2: 验证语法**

Run: `cd /Users/shifeng/claude-api-proxy && node --check src/routes/copilot-frontend.js`
Expected: 无输出

- [ ] **Step 3: Commit**

```bash
git add src/routes/copilot-frontend.js
git commit -m "feat: add copilot frontend route for admin panel"
```

---

### Task 5: 创建 copilot-admin.html — 管理面板

**Files:**
- Create: `src/templates/copilot-admin.html`
- Reference: `src/templates/codebuddy-admin.html`（视觉风格参考）

- [ ] **Step 1: 创建 copilot-admin.html**

复用 CodeBuddy 管理面板的视觉风格（紫色渐变、圆角卡片、相同的 CSS 变量和布局），页面包含 4 个卡片区域。由于 HTML 文件较长（约 1200-1400 行），完整代码如下：

```html
<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Copilot 管理面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa; color: #333; line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; padding: 20px 30px; margin-bottom: 30px;
            border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            display: flex; justify-content: space-between; align-items: center;
        }
        header h1 { font-size: 1.5rem; }
        .card {
            background: white; border-radius: 12px; padding: 24px;
            margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .card h2 {
            color: #667eea; margin-bottom: 16px; font-size: 1.15rem;
            display: flex; align-items: center; gap: 8px;
        }
        .btn {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 10px 20px; border: none; border-radius: 8px;
            font-size: 0.9rem; cursor: pointer; transition: all 0.3s ease; font-weight: 500;
        }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(102,126,234,0.4); }
        .btn-danger { background: #ef4444; color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-secondary { background: #f3f4f6; color: #374151; }
        .btn-secondary:hover { background: #e5e7eb; }
        .btn-warning { background: #f59e0b; color: white; }
        .btn-warning:hover { background: #d97706; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-small { padding: 6px 12px; font-size: 0.8rem; }

        .auth-box {
            background: #f8fafc; border: 2px dashed #cbd5e1;
            border-radius: 12px; padding: 30px; text-align: center;
        }
        .auth-box.active { border-color: #667eea; background: #eef2ff; }
        .auth-code {
            font-size: 2rem; font-weight: 700; letter-spacing: 4px;
            color: #667eea; background: #f8fafc; padding: 12px 24px;
            border-radius: 8px; display: inline-block; margin: 12px 0;
            font-family: 'Courier New', monospace; user-select: all;
        }
        .auth-link {
            display: inline-block; background: #667eea; color: white;
            padding: 10px 20px; border-radius: 8px; text-decoration: none;
            margin: 10px 0; font-size: 0.85rem;
        }
        .auth-link:hover { background: #5a67d8; }

        .loading {
            display: inline-block; width: 18px; height: 18px;
            border: 3px solid #f3f3f3; border-top: 3px solid #667eea;
            border-radius: 50%; animation: spin 1s linear infinite;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .toast {
            position: fixed; top: 20px; right: 20px; padding: 12px 24px;
            border-radius: 8px; color: white; font-size: 0.9rem;
            z-index: 1000; opacity: 0; transition: opacity 0.3s;
        }
        .toast.show { opacity: 1; }
        .toast.success { background: #10b981; }
        .toast.error { background: #ef4444; }

        .stats-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
        }
        .stat-item {
            background: #f8fafc; border-radius: 8px; padding: 16px; text-align: center;
        }
        .stat-value { font-size: 1.5rem; font-weight: 700; color: #667eea; }
        .stat-label { font-size: 0.8rem; color: #6b7280; margin-top: 4px; }

        .proxy-grid {
            display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
        }
        .proxy-grid input {
            width: 100%; padding: 10px 12px; border: 1px solid #d1d5db;
            border-radius: 8px; font-size: 0.9rem;
        }
        .proxy-grid input:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102,126,234,0.2); }

        .user-info { display: flex; align-items: center; gap: 16px; }
        .user-avatar { width: 48px; height: 48px; border-radius: 50%; }
        .user-details h3 { font-size: 1rem; color: #1f2937; }
        .user-details p { font-size: 0.85rem; color: #6b7280; }

        .token-status { margin-top: 12px; }
        .status-badge {
            display: inline-block; padding: 4px 12px; border-radius: 20px;
            font-size: 0.75rem; font-weight: 500;
        }
        .status-badge.active { background: #d1fae5; color: #065f46; }
        .status-badge.expired { background: #fee2e2; color: #991b1b; }
        .status-badge.pending { background: #fef3c7; color: #92400e; }

        .config-code {
            background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 8px;
            font-family: 'Courier New', monospace; font-size: 0.85rem;
            margin-top: 12px; position: relative;
        }
        .config-code .copy-btn {
            position: absolute; top: 8px; right: 8px; background: rgba(255,255,255,0.1);
            color: #e2e8f0; border: none; padding: 4px 8px; border-radius: 4px;
            cursor: pointer; font-size: 0.75rem;
        }
        .config-code .copy-btn:hover { background: rgba(255,255,255,0.2); }

        .month-selector { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
        .month-btn {
            padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 6px;
            background: white; cursor: pointer; font-size: 0.85rem;
        }
        .month-btn.active { background: #667eea; color: white; border-color: #667eea; }

        .chart-container { height: 200px; position: relative; margin-top: 16px; }
        .chart-bar-group { display: flex; align-items: flex-end; height: 180px; gap: 2px; padding: 0 4px; }
        .chart-bar {
            flex: 1; min-width: 8px; background: linear-gradient(180deg, #667eea 0%, #764ba2 100%);
            border-radius: 3px 3px 0 0; transition: height 0.3s ease; position: relative;
            cursor: pointer;
        }
        .chart-bar:hover { opacity: 0.8; }
        .chart-bar .tooltip {
            display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
            background: #1e293b; color: white; padding: 6px 10px; border-radius: 6px;
            font-size: 0.7rem; white-space: nowrap; z-index: 10;
        }
        .chart-bar:hover .tooltip { display: block; }
        .chart-labels { display: flex; gap: 2px; padding: 4px; }
        .chart-labels span {
            flex: 1; text-align: center; font-size: 0.65rem; color: #9ca3af;
            min-width: 8px;
        }

        .key-display {
            display: flex; align-items: center; gap: 12px; padding: 12px 16px;
            background: #f8fafc; border-radius: 8px; margin-top: 12px;
        }
        .key-value { font-family: 'Courier New', monospace; font-size: 0.9rem; color: #374151; flex: 1; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>GitHub Copilot 管理面板</h1>
            <div style="font-size:0.85rem; opacity:0.9;">
                <span id="header-status">加载中...</span>
            </div>
        </header>

        <!-- 认证卡片 -->
        <div class="card">
            <h2>&#x1F511; GitHub 认证</h2>
            <div id="auth-section">
                <!-- 动态内容由 JS 填充 -->
            </div>
        </div>

        <!-- API Key 卡片 -->
        <div class="card">
            <h2>&#x1F511; API Key</h2>
            <div id="apikey-section">
                <div class="key-display">
                    <span class="key-value" id="apikey-prefix">加载中...</span>
                    <button class="btn btn-warning btn-small" onclick="regenerateApiKey()">重新生成</button>
                </div>
                <div class="config-code" id="config-code" style="display:none;">
                    <button class="copy-btn" onclick="copyConfig()">复制</button>
                    <div id="config-text"></div>
                </div>
            </div>
        </div>

        <!-- 统计卡片 -->
        <div class="card">
            <h2>&#x1F4CA; 用量统计</h2>
            <div id="stats-section">
                <div class="stats-grid" id="stats-grid">加载中...</div>
                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <h3 style="font-size:0.95rem; color:#374151;">自定义统计 <span style="font-size:0.75rem; color:#9ca3af;">(可重置)</span></h3>
                    <button class="btn btn-secondary btn-small" onclick="resetCustomStats()">重置</button>
                </div>
                <div class="stats-grid" id="custom-stats-grid">加载中...</div>
                <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
                <h3 style="font-size:0.95rem; color:#374151; margin-bottom:12px;">每日用量</h3>
                <div class="month-selector" id="month-selector"></div>
                <div class="chart-container">
                    <div class="chart-bar-group" id="chart-bars"></div>
                    <div class="chart-labels" id="chart-labels"></div>
                </div>
            </div>
        </div>

        <!-- 代理配置卡片 -->
        <div class="card">
            <h2>&#x1F310; 代理配置</h2>
            <div class="proxy-grid">
                <div>
                    <label style="font-size:0.85rem; color:#6b7280; display:block; margin-bottom:4px;">HTTP Proxy</label>
                    <input type="text" id="http-proxy" placeholder="http://127.0.0.1:7890" />
                </div>
                <div>
                    <label style="font-size:0.85rem; color:#6b7280; display:block; margin-bottom:4px;">HTTPS Proxy</label>
                    <input type="text" id="https-proxy" placeholder="http://127.0.0.1:7890" />
                </div>
            </div>
            <button class="btn btn-primary" style="margin-top:12px;" onclick="saveProxy()">保存代理配置</button>
        </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
        const API_BASE = '/copilotFE';
        let authPollTimer = null;
        let currentMonth = '';

        // ==================== 工具函数 ====================

        function showToast(msg, type = 'success') {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = `toast ${type} show`;
            setTimeout(() => t.className = 'toast', 3000);
        }

        async function api(path, method = 'GET', body = null) {
            const opts = {method, headers: {'Content-Type': 'application/json'}};
            if (body) opts.body = JSON.stringify(body);
            const resp = await fetch(`${API_BASE}${path}`, opts);
            return resp.json();
        }

        function formatNumber(n) {
            if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
            return String(n);
        }

        // ==================== 加载状态 ====================

        async function loadStatus() {
            const data = await api('/status');
            document.getElementById('header-status').textContent =
                data.authenticated ? `已认证: ${data.userInfo?.login || 'unknown'}` : '未认证';
            renderAuthSection(data);
            renderApiKeySection(data);
            renderStatsSection(data);
            renderProxySection(data);
        }

        // ==================== 认证区域 ====================

        function renderAuthSection(data) {
            const el = document.getElementById('auth-section');
            if (data.authenticated) {
                const info = data.userInfo || {};
                el.innerHTML = `
                    <div class="user-info">
                        ${info.avatar_url ? `<img class="user-avatar" src="${info.avatar_url}" alt="avatar" />` : ''}
                        <div class="user-details">
                            <h3>${info.login || info.name || 'unknown'}</h3>
                            <p>${info.email || ''}</p>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="handleLogout()" style="margin-left:auto;">登出</button>
                    </div>
                    <div class="token-status" style="margin-top:12px;">
                        ${data.tokenStatus?.hasCopilotToken ?
                            (data.tokenStatus.copilotTokenExpired ?
                                '<span class="status-badge expired">Copilot Token 已过期</span>' :
                                '<span class="status-badge active">Copilot Token 有效</span>') :
                            '<span class="status-badge pending">Copilot Token 未获取</span>'
                        }
                        <span style="font-size:0.8rem; color:#6b7280; margin-left:8px;">
                            账户类型: ${data.tokenStatus?.accountType || 'individual'}
                        </span>
                    </div>
                `;
            } else {
                el.innerHTML = `
                    <div class="auth-box">
                        <p style="margin-bottom:16px; color:#6b7280;">需要通过 GitHub 设备码完成认证</p>
                        <button class="btn btn-primary" onclick="startAuth()">GitHub 认证</button>
                    </div>
                `;
            }
        }

        let authState = null;

        async function startAuth() {
            const el = document.getElementById('auth-section');
            el.innerHTML = `<div class="auth-box"><div class="loading"></div> <span>正在获取设备码...</span></div>`;
            try {
                const data = await api('/auth/start');
                if (!data.success) throw new Error(data.error || '获取设备码失败');
                authState = data;
                el.innerHTML = `
                    <div class="auth-box active">
                        <p style="margin-bottom:8px; color:#374151;">请在浏览器中打开以下链接，并输入设备码完成授权</p>
                        <div class="auth-code" id="user-code">${data.user_code}</div>
                        <br/>
                        <a class="auth-link" href="${data.verification_uri}" target="_blank">${data.verification_uri}</a>
                        <p style="margin-top:12px; font-size:0.85rem; color:#6b7280;">
                            <span class="loading"></span> 等待授权中...
                        </p>
                        <button class="btn btn-secondary btn-small" style="margin-top:8px;" onclick="cancelAuth()">取消</button>
                    </div>
                `;
                // 复制设备码到剪贴板
                try { await navigator.clipboard.writeText(data.user_code); } catch {}
                // 开始轮询
                startAuthPoll(data.device_code, data.interval, data.expires_in);
            } catch (error) {
                showToast('获取设备码失败: ' + error.message, 'error');
                loadStatus();
            }
        }

        function startAuthPoll(deviceCode, interval, expiresIn) {
            if (authPollTimer) clearInterval(authPollTimer);
            authPollTimer = setInterval(async () => {
                try {
                    const result = await api('/auth/poll', 'POST', {
                        device_code: deviceCode, interval, expires_in: expiresIn
                    });
                    if (result.status === 'success') {
                        clearInterval(authPollTimer);
                        authPollTimer = null;
                        showToast('认证成功！');
                        loadStatus();
                    } else if (result.status === 'expired') {
                        clearInterval(authPollTimer);
                        authPollTimer = null;
                        showToast('设备码已过期，请重新认证', 'error');
                        loadStatus();
                    }
                    // status === 'pending' 时继续轮询
                } catch (error) {
                    clearInterval(authPollTimer);
                    authPollTimer = null;
                    showToast('认证轮询失败: ' + error.message, 'error');
                    loadStatus();
                }
            }, (interval || 5) * 1000);
        }

        function cancelAuth() {
            if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
            loadStatus();
        }

        async function handleLogout() {
            if (!confirm('确定要登出 GitHub 认证吗？')) return;
            await api('/auth/clear', 'POST');
            showToast('已登出');
            loadStatus();
        }

        // ==================== API Key 区域 ====================

        function renderApiKeySection(data) {
            document.getElementById('apikey-prefix').textContent = data.apiKeyPrefix || 'N/A';
            const configEl = document.getElementById('config-code');
            const configText = document.getElementById('config-text');
            if (data.apiKeyPlain) {
                configEl.style.display = 'block';
                configText.textContent = JSON.stringify({
                    env: {
                        ANTHROPIC_AUTH_TOKEN: data.apiKeyPlain,
                        ANTHROPIC_BASE_URL: `${window.location.origin}/copilot/anthropic`
                    }
                }, null, 4);
            } else {
                configEl.style.display = 'block';
                configText.textContent = '// API Key 仅在首次生成时显示\n// 如需查看请重新生成';
            }
        }

        async function regenerateApiKey() {
            if (!confirm('重新生成 API Key 后，旧 Key 将立即失效。确定？')) return;
            const data = await api('/apikey/regenerate', 'POST');
            if (data.api_key) {
                showToast('API Key 已重新生成，请立即保存！');
                loadStatus();
            } else {
                showToast('重新生成失败: ' + (data.error || ''), 'error');
            }
        }

        function copyConfig() {
            const text = document.getElementById('config-text').textContent;
            navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板'));
        }

        // ==================== 统计区域 ====================

        function renderStatsSection(data) {
            const usage = data.usage || {};
            // 累计统计
            document.getElementById('stats-grid').innerHTML = `
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.api_call_count || 0)}</div><div class="stat-label">API 调用次数</div></div>
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.input_tokens || 0)}</div><div class="stat-label">输入 Token</div></div>
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.output_tokens || 0)}</div><div class="stat-label">输出 Token</div></div>
            `;
            // 自定义统计
            document.getElementById('custom-stats-grid').innerHTML = `
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.custom_api_call_count || 0)}</div><div class="stat-label">API 调用次数</div></div>
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.custom_input_tokens || 0)}</div><div class="stat-label">输入 Token</div></div>
                <div class="stat-item"><div class="stat-value">${formatNumber(usage.custom_output_tokens || 0)}</div><div class="stat-label">输出 Token</div></div>
            `;
            loadDailyChart();
        }

        async function resetCustomStats() {
            if (!confirm('确定要重置自定义统计数据？')) return;
            await api('/stats/custom-reset', 'POST');
            showToast('自定义统计已重置');
            loadStatus();
        }

        async function loadDailyChart(month) {
            if (!month) {
                const now = new Date();
                month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            }
            currentMonth = month;
            const data = await api(`/stats/daily?month=${month}`);
            renderMonthSelector(data.available_months || [month]);
            renderChart(data.data || {});
        }

        function renderMonthSelector(months) {
            const el = document.getElementById('month-selector');
            el.innerHTML = months.map(m =>
                `<button class="month-btn ${m === currentMonth ? 'active' : ''}" onclick="loadDailyChart('${m}')">${m}</button>`
            ).join('');
        }

        function renderChart(dailyData) {
            const bars = document.getElementById('chart-bars');
            const labels = document.getElementById('chart-labels');
            const daysInMonth = new Date(
                parseInt(currentMonth.split('-')[0]),
                parseInt(currentMonth.split('-')[1]), 0
            ).getDate();

            let maxCalls = 0;
            for (let d = 1; d <= daysInMonth; d++) {
                const key = String(d).padStart(2, '0');
                const dayData = dailyData[key];
                if (dayData && dayData.api_calls > maxCalls) maxCalls = dayData.api_calls;
            }
            if (maxCalls === 0) maxCalls = 1;

            let barsHtml = '';
            let labelsHtml = '';
            for (let d = 1; d <= daysInMonth; d++) {
                const key = String(d).padStart(2, '0');
                const dayData = dailyData[key];
                const calls = dayData ? dayData.api_calls : 0;
                const height = calls > 0 ? Math.max(4, (calls / maxCalls) * 170) : 0;
                const tooltip = dayData ?
                    `${key}日: ${calls}次 / ${formatNumber(dayData.input_tokens)}in / ${formatNumber(dayData.output_tokens)}out` :
                    `${key}日: 无数据`;
                barsHtml += `<div class="chart-bar" style="height:${height}px;"><div class="tooltip">${tooltip}</div></div>`;
                if (d === 1 || d === 10 || d === 20 || d === daysInMonth) {
                    labelsHtml += `<span>${d}</span>`;
                } else {
                    labelsHtml += `<span></span>`;
                }
            }
            bars.innerHTML = barsHtml;
            labels.innerHTML = labelsHtml;
        }

        // ==================== 代理配置 ====================

        function renderProxySection(data) {
            const proxy = data.proxy || {};
            document.getElementById('http-proxy').value = proxy.http_proxy || '';
            document.getElementById('https-proxy').value = proxy.https_proxy || '';
        }

        async function saveProxy() {
            const httpProxy = document.getElementById('http-proxy').value.trim();
            const httpsProxy = document.getElementById('https-proxy').value.trim();
            const data = await api('/proxy', 'POST', {http_proxy: httpProxy, https_proxy: httpsProxy});
            if (data.message) {
                showToast('代理配置已保存');
            } else {
                showToast('保存失败: ' + (data.error || ''), 'error');
            }
        }

        // ==================== 初始化 ====================

        loadStatus();
        setInterval(loadStatus, 30000);
    </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/templates/copilot-admin.html
git commit -m "feat: add Copilot admin panel HTML template"
```

---

### Task 6: 修改 server.js — 注册 /copilotFE 路由

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 在 server.js 顶部添加导入**

在现有 `import { routeCopilotRequest } from './routes/copilot.js';` 后面添加：

```javascript
import { routeCopilotFrontend } from './routes/copilot-frontend.js';
```

- [ ] **Step 2: 在路由分发中添加 /copilotFE 路由**

在 server.js 的请求处理函数中，找到 Copilot 路由的判断：

```javascript
// Copilot 路由
if (req.url.startsWith('/copilot')) {
```

将其修改为：

```javascript
// Copilot 前端管理界面（必须在 /copilot 通用路由之前）
if (req.url.startsWith('/copilotFE')) {
    try {
        await routeCopilotFrontend(req, res);
        return;
    } catch (err) {
        logger.error('Copilot frontend error:', err);
        sendError(res, 500, 'Internal server error');
        return;
    }
}

// Copilot 路由
if (req.url.startsWith('/copilot')) {
```

- [ ] **Step 3: 在日志过滤中添加 /copilotFE**

找到 `isKnown` 变量定义，在 `req.url.startsWith('/copilot')` 之后添加一行：

```javascript
req.url.startsWith('/copilotFE') ||
```

- [ ] **Step 4: 在根路径欢迎信息中添加 copilotFE 端点**

找到根路径 `/` 返回的 JSON 中的 `endpoints` 对象，在 `copilot` 条目后添加：

```javascript
copilotFE: '/copilotFE - Copilot Web Admin UI',
```

- [ ] **Step 5: Commit**

```bash
git add src/server.js
git commit -m "feat: register /copilotFE route in server"
```

---

### Task 7: 修改 index.js — 移除自动认证

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: 替换 Copilot 初始化逻辑**

将整个 `initializeCopilot()` 函数替换为：

```javascript
/**
 * 初始化 Copilot 服务
 */
function initializeCopilot() {
    const apiInfo = copilotStore.getApiKeyInfo();
    logger.info(`Copilot API Key: ${apiInfo.prefix}`);

    if (isAuthenticated()) {
        logger.info('Already authenticated with GitHub');
        // 后台刷新 Copilot Token
        (async () => {
            try {
                const proxyUrl = copilotStore.getProxyConfig().https_proxy || copilotStore.getProxyConfig().http_proxy;
                await refreshCopilotToken(proxyUrl);
                logger.info('Copilot token refreshed');
            } catch (error) {
                logger.warn('Failed to refresh Copilot token:', error.message);
            }
        })();
    } else {
        logger.info('Copilot not authenticated');
        logger.info('  Please visit /copilotFE to authenticate with GitHub');
    }
}
```

- [ ] **Step 2: 在 index.js 顶部添加导入**

在现有导入行后添加：

```javascript
import {copilotStore} from './services/copilot/copilot-store.js';
```

- [ ] **Step 3: 删除 AUTO_AUTH 常量**

删除这一行：

```javascript
const AUTO_AUTH = process.env.COPILOT_AUTO_AUTH !== 'false';
```

- [ ] **Step 4: 在启动日志中添加 Copilot admin UI 提示**

找到启动成功后的 `console.log` 列表，在 `Copilot proxy endpoint` 之后添加：

```javascript
console.log(`✓ Copilot admin UI: http://${localIp}:${PORT}/copilotFE`);
```

- [ ] **Step 5: 在 shutdown 中添加 copilotStore flush**

找到 `shutdown` 函数中的 flush 调用，在 `relayStore.flushApiCallCounts();` 后添加：

```javascript
copilotStore.flushApiCallCounts();
```

注意：需要在文件顶部已有 `copilotStore` 的导入。

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: replace console auth with FE-based auth, add copilotStore init"
```

---

### Task 8: 集成验证

- [ ] **Step 1: 启动服务验证无报错**

Run: `cd /Users/shifeng/claude-api-proxy && timeout 5 npm start 2>&1 || true`
Expected: 启动日志中显示 `Copilot API Key: sk-copilot-****` 和 `Copilot admin UI: http://...` 提示，无报错

- [ ] **Step 2: 验证管理面板可访问**

在浏览器打开 `http://127.0.0.1:3080/copilotFE`，确认：
- 页面正常渲染，4 个卡片区域可见
- 点击「GitHub 认证」按钮能获取设备码
- API Key 区域显示 `sk-copilot-****`
- 统计区域显示全 0
- 代理配置区域显示当前代理

- [ ] **Step 3: 验证 API Key 鉴权生效**

不带 API Key 调用 Copilot 接口：
```bash
curl -X POST http://127.0.0.1:3080/copilot/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'
```
Expected: 返回 401 错误

带正确 API Key 调用：
```bash
curl -X POST http://127.0.0.1:3080/copilot/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <sk-copilot-xxx>" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}'
```
Expected: 如果已认证 GitHub，正常返回；否则返回 401 提示去 FE 认证

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: Copilot FE management panel - auth, API key, stats, proxy"
```
