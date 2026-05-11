/**
 * Relay 存储管理器
 * 管理 API Key 鉴权、UpstreamManager 实例及使用量统计
 * @module services/relay/relay-store
 */

import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'fs';
import {randomBytes, createHash} from 'crypto';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {RELAY_CREDS_DIR} from './config.js';
import {UpstreamManager} from './upstream-manager.js';

const API_KEY_FILE = 'api_key.json';
const USAGE_FILE = 'usage.json';

class RelayStore {
    constructor() {
        this.baseDir = join(process.cwd(), RELAY_CREDS_DIR);
        this.apiKeyFile = join(this.baseDir, API_KEY_FILE);
        this.usageFile = join(this.baseDir, USAGE_FILE);

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

        // Upstream manager
        this.upstreamManager = null;

        this._init();
    }

    _init() {
        if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, {recursive: true});
        this._loadApiKey();
        this._loadUsage();
        this.upstreamManager = new UpstreamManager(this.baseDir);
    }

    _loadApiKey() {
        if (existsSync(this.apiKeyFile)) {
            try {
                const data = JSON.parse(readFileSync(this.apiKeyFile, 'utf8'));
                this.apiKeyHash = data.api_key_hash;
                this.apiKeyPrefix = data.api_key_prefix;
                this.apiKey = data.api_key_plain || null;
            } catch (err) {
                logger.error('Failed to load Relay API key file:', err.message);
            }
        }
        if (!this.apiKeyHash) {
            this._generateApiKey();
        }
    }

    _generateApiKey() {
        const key = 'sk-relay-' + randomBytes(16).toString('hex');
        this.apiKey = key;
        this.apiKeyHash = createHash('sha256').update(key).digest('hex');
        this.apiKeyPrefix = key.substring(0, 10) + '****' + key.substring(key.length - 4);
        this._saveApiKey();
        logger.info(`Generated Relay API Key: ${key}`);
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
            } catch {
            }
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

    authenticate(apiKey) {
        const hash = createHash('sha256').update(apiKey).digest('hex');
        return hash === this.apiKeyHash;
    }

    getUpstreamManager() {
        return this.upstreamManager;
    }

    getApiKeyInfo() {
        return {prefix: this.apiKeyPrefix, hash: this.apiKeyHash, key: this.apiKey, apiKeyPlain: this.apiKey};
    }

    regenerateApiKey() {
        this._generateApiKey();
        return this.apiKey;
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

    recordDailyUsage(inputTokens, outputTokens) {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        let dailyData = {};
        if (existsSync(dailyFile)) {
            try {
                dailyData = JSON.parse(readFileSync(dailyFile, 'utf8'));
            } catch {
            }
        }
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dayKey = String(now.getDate()).padStart(2, '0');
        if (!dailyData[monthKey]) dailyData[monthKey] = {};
        if (!dailyData[monthKey][dayKey]) {
            dailyData[monthKey][dayKey] = {api_calls: 0, input_tokens: 0, output_tokens: 0};
        }
        dailyData[monthKey][dayKey].api_calls += 1;
        dailyData[monthKey][dayKey].input_tokens += inputTokens || 0;
        dailyData[monthKey][dayKey].output_tokens += outputTokens || 0;
        // Cleanup old data (> 3 months)
        const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
        for (const mk of Object.keys(dailyData)) {
            if (mk < cutoffKey) delete dailyData[mk];
        }
        writeFileSync(dailyFile, JSON.stringify(dailyData, null, 2), 'utf8');
    }

    getDailyUsage(monthKey) {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        if (!existsSync(dailyFile)) return null;
        try {
            const dailyData = JSON.parse(readFileSync(dailyFile, 'utf8'));
            return dailyData[monthKey] || null;
        } catch {
            return null;
        }
    }

    getAvailableMonths() {
        const dailyFile = join(this.baseDir, 'daily_usage.json');
        if (!existsSync(dailyFile)) return [];
        try {
            const dailyData = JSON.parse(readFileSync(dailyFile, 'utf8'));
            return Object.keys(dailyData).sort().reverse().slice(0, 3);
        } catch {
            return [];
        }
    }
}

export const relayStore = new RelayStore();
