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
