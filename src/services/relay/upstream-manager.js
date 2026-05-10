/**
 * 上游配置管理器
 * 管理每个租户的多上游配置（base_url + api_key + proxy）、活跃上游、故障转移
 * @module services/relay/upstream-manager
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {join} from 'path';
import {buildUrl} from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const UPSTREAMS_FILE = 'upstreams.json';

// 单上游重试次数，范围 1-3
const DEFAULT_RETRY_COUNT = 3;
const MIN_RETRY_COUNT = 1;
const MAX_RETRY_COUNT = 5;

/**
 * 获取兜底模型名：优先 model_map 第一个 value，其次 models[0]
 */
function _getFallbackModel(upstream) {
    if (upstream.model_map && typeof upstream.model_map === 'object') {
        const values = Object.values(upstream.model_map);
        if (values.length > 0) return values[0];
    }
    if (Array.isArray(upstream.models) && upstream.models.length > 0) {
        return upstream.models[0];
    }
    return null;
}

export {MIN_RETRY_COUNT, MAX_RETRY_COUNT};

export class UpstreamManager {
    constructor(tenantDir) {
        this.tenantDir = tenantDir;
        this.upstreamsPath = join(tenantDir, UPSTREAMS_FILE);
        this.upstreams = [];
        // 活跃上游索引，-1 表示使用第一个启用的上游
        this._activeIndex = -1;
        // 单上游重试次数
        this._retryCount = DEFAULT_RETRY_COUNT;
        this._loadUpstreams();
    }

    _loadUpstreams() {
        try {
            if (existsSync(this.upstreamsPath)) {
                this.upstreams = JSON.parse(readFileSync(this.upstreamsPath, 'utf8'));
                if (!Array.isArray(this.upstreams)) this.upstreams = [];
            }
        } catch (error) {
            logger.error(`Relay: 加载上游配置失败: ${error.message}`);
            this.upstreams = [];
        }
    }

    _saveUpstreams() {
        try {
            if (!existsSync(this.tenantDir)) mkdirSync(this.tenantDir, {recursive: true});
            writeFileSync(this.upstreamsPath, JSON.stringify(this.upstreams, null, 2), 'utf8');
        } catch (error) {
            logger.error(`Relay: 保存上游配置失败: ${error.message}`);
        }
    }

    /**
     * 列出所有上游配置，标记活跃上游
     */
    listUpstreams() {
        const activeIdx = this._getActiveIndex();
        return this.upstreams.map((u, i) => ({
            index: i,
            name: u.name,
            base_url: u.base_url,
            api_key_preview: u.api_key ? u.api_key.slice(0, 8) + '****' + u.api_key.slice(-4) : '',
            api_key_full: u.api_key || '',
            proxy: u.proxy || '',
            models: u.models || [],
            model_map: u.model_map || {},
            model_auto: u.model_auto || false,
            retry_count: u.retry_count || 0,
            enabled: u.enabled !== false,
            created_at: u.created_at,
            is_active: i === activeIdx
        }));
    }

    /**
     * 获取实际活跃上游索引（_activeIndex 指向的上游必须启用）
     * 如果指定的不启用或越界，回退到第一个启用的上游
     */
    _getActiveIndex() {
        if (
            this._activeIndex >= 0 &&
            this._activeIndex < this.upstreams.length &&
            this.upstreams[this._activeIndex].enabled !== false
        ) {
            return this._activeIndex;
        }
        return this.upstreams.findIndex((u) => u.enabled !== false);
    }

    /**
     * 设置活跃上游
     * @param {number} index - 上游索引
     */
    setActiveUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        if (this.upstreams[index].enabled === false) return false;
        this._activeIndex = index;
        logger.info(`Relay: 活跃上游已切换为「${this.upstreams[index].name}」(index: ${index})`);
        return true;
    }

    /**
     * 获取当前活跃上游
     * @returns {Object|null} {name, base_url, api_key, proxy, enabled, index}
     */
    getActiveUpstream() {
        const idx = this._getActiveIndex();
        if (idx < 0) return null;
        return {...this.upstreams[idx], index: idx};
    }

    /**
     * 获取所有启用的上游（活跃上游排在最前），用于故障转移
     * @returns {Array<{name, base_url, api_key, proxy, enabled, index}>}
     */
    getEnabledUpstreams() {
        const enabled = this.upstreams.map((u, i) => ({...u, index: i})).filter((u) => u.enabled !== false);
        const activeIdx = this._getActiveIndex();
        if (activeIdx < 0) return enabled;
        const activeItem = enabled.find((u) => u.index === activeIdx);
        if (!activeItem) return enabled;
        return [activeItem, ...enabled.filter((u) => u.index !== activeIdx)];
    }

    /**
     * 记录上游请求成功（当前为空操作，保留接口）
     */
    recordSuccess(_index) {}

    /**
     * 记录上游请求失败（当前为空操作，保留接口）
     */
    recordFailure(_index, _reason) {}

    setRetryCount(count) {
        if (count && count > 0) {
            this._retryCount = Math.max(MIN_RETRY_COUNT, Math.min(MAX_RETRY_COUNT, count));
        }
    }

    getRetryCount() {
        return this._retryCount;
    }

    /**
     * 解析请求模型名到该上游实际使用的模型名
     * 1. model_map 精确匹配
     * 2. 请求模型为 'auto'，优先 model_map 第一个 value，其次 models[0]
     * 3. model_auto=true 兜底，优先 model_map 第一个 value，其次 models[0]
     * 4. 以上都不匹配则透传原始模型名
     */
    resolveModel(requestedModel, upstreamIndex) {
        if (upstreamIndex < 0 || upstreamIndex >= this.upstreams.length) return requestedModel;
        const upstream = this.upstreams[upstreamIndex];

        // 1. model_map 精确匹配
        if (upstream.model_map && typeof upstream.model_map === 'object') {
            const mapped = upstream.model_map[requestedModel];
            if (mapped) {
                return mapped;
            }
        }

        // 2. 请求模型为 'auto'
        if (requestedModel === 'auto') {
            const fallback = _getFallbackModel(upstream);
            if (fallback) {
                return fallback;
            }
        }

        // 3. model_auto 兜底
        if (upstream.model_auto === true) {
            const fallback = _getFallbackModel(upstream);
            if (fallback) {
                return fallback;
            }
        }

        // 4. 透传
        return requestedModel;
    }

    /**
     * 获取指定上游的重试次数（上游级配置 > 租户级默认值）
     */
    getUpstreamRetryCount(index) {
        if (index < 0 || index >= this.upstreams.length) return this._retryCount;
        const upstream = this.upstreams[index];
        const count = upstream.retry_count && upstream.retry_count > 0 ? upstream.retry_count : this._retryCount;
        return Math.max(MIN_RETRY_COUNT, Math.min(MAX_RETRY_COUNT, count));
    }

    addUpstream(data) {
        const upstream = {
            name: data.name || 'Unnamed',
            base_url: data.base_url || '',
            api_key: data.api_key || '',
            proxy: data.proxy || '',
            models: data.models || [],
            model_map: data.model_map || {},
            model_auto: data.model_auto || false,
            retry_count: data.retry_count || 0,
            enabled: data.enabled !== false,
            created_at: Math.floor(Date.now() / 1000)
        };
        if (!upstream.base_url) {
            throw new Error('base_url is required');
        }
        this.upstreams.push(upstream);
        this._saveUpstreams();
        return {index: this.upstreams.length - 1, ...upstream};
    }

    updateUpstream(index, data) {
        if (index < 0 || index >= this.upstreams.length) return null;
        const upstream = this.upstreams[index];
        if (data.name !== undefined) upstream.name = data.name;
        if (data.base_url !== undefined) upstream.base_url = data.base_url;
        if (data.api_key !== undefined) upstream.api_key = data.api_key;
        if (data.proxy !== undefined) upstream.proxy = data.proxy;
        if (data.enabled !== undefined) upstream.enabled = data.enabled;
        if (data.models !== undefined) upstream.models = data.models;
        if (data.model_map !== undefined) upstream.model_map = data.model_map;
        if (data.model_auto !== undefined) upstream.model_auto = data.model_auto;
        if (data.retry_count !== undefined) upstream.retry_count = data.retry_count;
        this._saveUpstreams();
        return {index, ...upstream};
    }

    deleteUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        this.upstreams.splice(index, 1);
        this._saveUpstreams();
        return true;
    }

    /**
     * 上移上游（提高优先级）
     */
    moveUp(index) {
        if (index <= 0 || index >= this.upstreams.length) return false;
        [this.upstreams[index - 1], this.upstreams[index]] = [this.upstreams[index], this.upstreams[index - 1]];
        this._saveUpstreams();
        return true;
    }

    /**
     * 下移上游（降低优先级）
     */
    moveDown(index) {
        if (index < 0 || index >= this.upstreams.length - 1) return false;
        [this.upstreams[index], this.upstreams[index + 1]] = [this.upstreams[index + 1], this.upstreams[index]];
        this._saveUpstreams();
        return true;
    }

    /**
     * 从上游获取模型列表
     */
    async _fetchFromModelsEndpoint(upstream) {
        const {request, readBody} = await import('../../utils/http-client.js');
        const {HttpsProxyAgent} = await import('https-proxy-agent');
        const {SocksProxyAgent} = await import('socks-proxy-agent');

        const url = buildUrl(upstream.base_url, 'models');
        const headers = {
            Authorization: `Bearer ${upstream.api_key}`,
            Accept: 'application/json',
            'User-Agent': 'Relay/1.0'
        };
        const options = {method: 'GET', headers, timeout: 15000};

        if (upstream.proxy) {
            options.agent = upstream.proxy.startsWith('socks')
                ? new SocksProxyAgent(upstream.proxy)
                : new HttpsProxyAgent(upstream.proxy);
        }

        try {
            const response = await request(url, options);
            const body = await readBody(response.body);
            if (response.status >= 200 && response.status < 300) {
                return JSON.parse(body);
            }
            return {_error: `HTTP ${response.status}: ${body.slice(0, 300)}`};
        } catch (err) {
            return {_error: err.message};
        }
    }

    async testUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) {
            return {success: false, message: '无效的上游索引'};
        }
        const upstream = this.upstreams[index];

        // 优先用 model_map 的第一个 value，其次 models[0]，否则回退到 models 接口获取
        let model = null;
        if (upstream.model_map && typeof upstream.model_map === 'object') {
            const values = Object.values(upstream.model_map);
            if (values.length > 0) model = values[0];
        }
        if (!model) {
            model = upstream.models?.[0];
        }
        if (!model) {
            const modelsResult = await this._fetchFromModelsEndpoint(upstream);
            if (modelsResult._error) {
                return {success: false, message: modelsResult._error};
            }
            model = modelsResult.data?.[0]?.id;
            if (!model) {
                return {success: false, message: '未找到可用模型'};
            }
        }

        const {request, readBody} = await import('../../utils/http-client.js');
        const {HttpsProxyAgent} = await import('https-proxy-agent');
        const {SocksProxyAgent} = await import('socks-proxy-agent');

        const url = buildUrl(upstream.base_url, 'chat/completions');
        const headers = {
            Authorization: `Bearer ${upstream.api_key}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Relay/1.0'
        };

        const payload = {
            model,
            messages: [{role: 'user', content: 'hi'}],
            max_tokens: 1,
            stream: false
        };

        const options = {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            timeout: 30000
        };

        if (upstream.proxy) {
            options.agent = upstream.proxy.startsWith('socks')
                ? new SocksProxyAgent(upstream.proxy)
                : new HttpsProxyAgent(upstream.proxy);
        }

        try {
            const response = await request(url, options);
            if (response.status >= 200 && response.status < 300) {
                return {success: true, message: `连接成功 (model: ${model})`};
            }
            const body = await readBody(response.body);
            const errorMsg = body.length > 300 ? body.substring(0, 300) + '...' : body;
            return {success: false, message: `HTTP ${response.status}: ${errorMsg}`};
        } catch (err) {
            return {success: false, message: err.message};
        }
    }

    getEnabledCount() {
        return this.upstreams.filter((u) => u.enabled !== false).length;
    }

    getCount() {
        return this.upstreams.length;
    }
}
