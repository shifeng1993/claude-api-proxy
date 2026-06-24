/**
 * 上游配置管理器
 * 管理每个租户的多上游配置（base_url + api_key + proxy）和活跃上游
 * 使用 Sequelize ORM 操作数据库，不再依赖文件系统读写
 * @module services/providers/upstream-manager
 */

import {
    getUpstreamModels,
    createChatCompletions,
    createResponses,
    createResponsesWebSocket,
    createAnthropicMessages,
    isAnthropicUpstream,
    isResponsesUpstream,
    isResponsesWebSocketUpstream,
    discardResponsesWebSocketConnection,
    buildResponsesWebSocketUrl
} from './upstream-api.js';
import {
    connectionPoolKey,
    discardByPoolKey,
    normalizeResponsesWebSocketMode
} from '../shared/index.js';
import logger from '../../utils/logger.js';
import {models} from '../../db/models/index.js';

const DEFAULT_UPSTREAM_TEST_TIMEOUT_MS = 30000;

function normalizeTimeoutMs(value, fallback = DEFAULT_UPSTREAM_TEST_TIMEOUT_MS) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForResponsesWebSocketCompleted(eventStream, timeoutMs, onTimeout) {
    const iterator = eventStream[Symbol.asyncIterator]();
    while (true) {
        let timer;
        const next = iterator.next();
        try {
            const result = await Promise.race([
                next,
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(`Responses WebSocket test timed out after ${timeoutMs}ms waiting for response.completed`));
                    }, timeoutMs);
                })
            ]);
            if (timer) clearTimeout(timer);
            if (result.done) {
                throw new Error('Responses WebSocket stream ended before response.completed');
            }
            if (result.value?.type === 'response.completed') return;
        } catch (error) {
            if (timer) clearTimeout(timer);
            if (/timed out/i.test(error.message)) {
                try {
                    onTimeout?.();
                } catch {}
                next.catch(() => {});
                try {
                    iterator.return?.();
                } catch {}
            }
            throw error;
        }
    }
}

export class UpstreamManager {
    constructor(options = {}) {
        this.tenantId = options.tenantId;
        this.testTimeoutMs = normalizeTimeoutMs(options.testTimeoutMs ?? process.env.RELAY_UPSTREAM_TEST_TIMEOUT_MS);
        this.upstreams = [];
        // 活跃上游索引，-1 表示使用第一个启用的上游
        this._activeIndex = -1;
        // 标记是否已初始化（DB 操作是异步的，需要外部调用 init()）
        this._initialized = false;
    }

    /**
     * 异步初始化：从数据库加载上游配置和设置
     * 必须在构造后调用
     */
    async init() {
        if (this._initialized) return;
        await this.reload();
        this._initialized = true;
    }

    /**
     * 重新从数据库加载上游配置和活跃索引
     * 用于缓存失效或数据可能过时时强制刷新
     */
    async reload() {
        await this._loadUpstreams();
        await this._loadSettings();
    }

    async _loadUpstreams() {
        try {
            const rows = await models.TenantUpstream.findAll({
                where: {tenant_id: this.tenantId},
                order: [['id', 'ASC']]
            });
            this.upstreams = rows.map((row) => row.get({plain: true}));
        } catch (error) {
            logger.error(`Provider: 加载上游配置失败: ${error.message}`);
            this.upstreams = [];
        }
    }

    async _loadSettings() {
        try {
            const state = await models.TenantState.findOne({
                where: {tenant_id: this.tenantId}
            });
            if (state && typeof state.active_upstream_index === 'number') {
                this._activeIndex = state.active_upstream_index;
            }
        } catch (error) {
            logger.error(`Provider: 加载设置失败: ${error.message}`);
        }
    }

    async _saveSettings() {
        try {
            await models.TenantState.upsert({
                tenant_id: this.tenantId,
                active_upstream_index: this._activeIndex,
                saved_at: new Date().toISOString()
            });
        } catch (error) {
            logger.error(`Provider: 保存设置失败: ${error.message}`);
        }
    }

    /**
     * 列出所有上游配置，标记活跃上游
     */
    listUpstreams() {
        const activeIdx = this._getActiveIndex();
        return this.upstreams.map((u, i) => ({
            index: i,
            id: u.id,
            name: u.name,
            base_url: u.base_url,
            api_key_preview: u.api_key ? u.api_key.slice(0, 8) + '****' + u.api_key.slice(-4) : '',
            api_key_full: u.api_key || '',
            proxy: u.proxy || '',
            models: u.models || [],
            model_map: u.model_map || {},
            model_auto: u.model_auto !== false,
            protocol: u.protocol || '',
            ws_mode: normalizeResponsesWebSocketMode(u.ws_mode),
            enabled: u.enabled !== false,
            skip_tls_verify: u.skip_tls_verify === true,
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
    async setActiveUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        if (this.upstreams[index].enabled === false) return false;

        // 用户主动切换上游时，清除旧上游的 WebSocket 连接池，避免连接复用导致请求仍走到旧上游
        const oldUpstream = this.getActiveUpstream();
        if (oldUpstream) {
            try {
                const wsUrl = buildResponsesWebSocketUrl(oldUpstream, 'responses');
                const proxyMode = oldUpstream.proxy ? oldUpstream.proxy : 'direct';
                const tlsPart = oldUpstream.skip_tls_verify ? 'tls-skip' : 'tls-verify';
                const networkKey = `${wsUrl}:${proxyMode}:${tlsPart}`;
                const oldPoolKey = connectionPoolKey(`${wsUrl}:${oldUpstream.api_key || ''}`, networkKey);
                discardByPoolKey(oldPoolKey);
                logger.info(`Provider: 切换上游时清除旧上游 WebSocket 连接: ${oldUpstream.name}, poolKey=${oldPoolKey}`);
            } catch (err) {
                logger.warn(`Provider: 切换上游时清除旧上游 WebSocket 连接失败: ${err.message}`);
            }
        }

        this._activeIndex = index;
        await this._saveSettings();
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
     * 解析请求模型名到该上游实际使用的模型名
     * 1. model_map 精确匹配
     * 2. 模式匹配兜底（model_auto 不为 false 时生效）
     * 3. 以上都不匹配则透传原始模型名
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

        // 2. 模式匹配兜底：将国外模型名自动映射到国内厂商可识别的模型
        if (upstream.model_auto !== false && typeof requestedModel === 'string') {
            const lower = requestedModel.toLowerCase();
            if (lower.startsWith('gpt-') || lower.includes('mini')) {
                return 'deepseek-v4-flash';
            }
        }

        // 3. 透传
        return requestedModel;
    }

    async addUpstream(data) {
        const upstreamData = {
            tenant_id: this.tenantId,
            name: data.name || 'Unnamed',
            base_url: data.base_url || '',
            api_key: data.api_key || '',
            proxy: data.proxy || '',
            models: data.models || [],
            model_map: data.model_map || {},
            model_auto: data.model_auto !== false,
            protocol: data.protocol || '',
            ws_mode: normalizeResponsesWebSocketMode(data.ws_mode),
            enabled: data.enabled !== false,
            skip_tls_verify: data.skip_tls_verify === true
        };
        if (!upstreamData.base_url) {
            throw new Error('base_url is required');
        }
        const row = await models.TenantUpstream.create(upstreamData);
        const upstream = row.get({plain: true});
        this.upstreams.push(upstream);
        return this.listUpstreams()[this.upstreams.length - 1];
    }

    async updateUpstream(index, data) {
        if (index < 0 || index >= this.upstreams.length) return null;
        const upstream = this.upstreams[index];
        const updateData = {};
        if (data.name !== undefined) updateData.name = data.name;
        if (data.base_url !== undefined) updateData.base_url = data.base_url;
        if (data.api_key !== undefined) updateData.api_key = data.api_key;
        if (data.proxy !== undefined) updateData.proxy = data.proxy;
        if (data.enabled !== undefined) updateData.enabled = data.enabled;
        if (data.models !== undefined) updateData.models = data.models;
        if (data.model_map !== undefined) updateData.model_map = data.model_map;
        if (data.model_auto !== undefined) updateData.model_auto = data.model_auto;
        if (data.protocol !== undefined) updateData.protocol = data.protocol;
        if (data.ws_mode !== undefined) updateData.ws_mode = normalizeResponsesWebSocketMode(data.ws_mode);
        if (data.skip_tls_verify !== undefined) updateData.skip_tls_verify = data.skip_tls_verify === true;

        await models.TenantUpstream.update(updateData, {where: {id: upstream.id}});
        // 更新内存中的数据
        Object.assign(upstream, updateData);
        return this.listUpstreams()[index];
    }

    async deleteUpstream(index) {
        if (index < 0 || index >= this.upstreams.length) return false;
        const upstream = this.upstreams[index];
        await models.TenantUpstream.destroy({where: {id: upstream.id}});
        this.upstreams.splice(index, 1);
        // 修正活跃索引
        if (this._activeIndex === index) {
            this._activeIndex = -1;
        } else if (this._activeIndex > index) {
            this._activeIndex--;
        }
        await this._saveSettings();
        return true;
    }

    /**
     * 上移上游（提高优先级）
     * 移动后删除该租户所有 upstream 再重新创建，确保顺序一致
     */
    async moveUp(index) {
        if (index <= 0 || index >= this.upstreams.length) return false;
        [this.upstreams[index - 1], this.upstreams[index]] = [this.upstreams[index], this.upstreams[index - 1]];
        // 活跃上游跟随移动
        if (this._activeIndex === index) {
            this._activeIndex = index - 1;
        } else if (this._activeIndex === index - 1) {
            this._activeIndex = index;
        }
        await this._rebuildUpstreamsOrder();
        await this._saveSettings();
        return true;
    }

    /**
     * 下移上游（降低优先级）
     * 移动后删除该租户所有 upstream 再重新创建，确保顺序一致
     */
    async moveDown(index) {
        if (index < 0 || index >= this.upstreams.length - 1) return false;
        [this.upstreams[index], this.upstreams[index + 1]] = [this.upstreams[index + 1], this.upstreams[index]];
        // 活跃上游跟随移动
        if (this._activeIndex === index) {
            this._activeIndex = index + 1;
        } else if (this._activeIndex === index + 1) {
            this._activeIndex = index;
        }
        await this._rebuildUpstreamsOrder();
        await this._saveSettings();
        return true;
    }

    /**
     * 删除该租户所有 upstream 并按当前数组顺序重新创建
     * 用这种方式保证数据库中的 id 顺序与内存数组一致
     */
    async _rebuildUpstreamsOrder() {
        try {
            await models.TenantUpstream.destroy({where: {tenant_id: this.tenantId}});
            const rows = [];
            for (const u of this.upstreams) {
                rows.push(
                    await models.TenantUpstream.create({
                        tenant_id: this.tenantId,
                        name: u.name,
                        base_url: u.base_url,
                        api_key: u.api_key,
                        proxy: u.proxy,
                        models: u.models,
                        model_map: u.model_map,
                        model_auto: u.model_auto,
                        protocol: u.protocol,
                        ws_mode: normalizeResponsesWebSocketMode(u.ws_mode),
                        enabled: u.enabled
                    })
                );
            }
            this.upstreams = rows.map((row) => row.get({plain: true}));
        } catch (error) {
            logger.error(`Provider: 重建上游顺序失败: ${error.message}`);
        }
    }

    /**
     * 从上游获取模型列表
     */
    async _fetchFromModelsEndpoint(upstream) {
        try {
            return await getUpstreamModels(upstream, {'anthropic-version': '2023-06-01'});
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

        try {
            let response;
            if (isAnthropicUpstream(upstream)) {
                response = await createAnthropicMessages(
                    {
                        model,
                        max_tokens: 16,
                        stream: true,
                        messages: [{role: 'user', content: 'hi'}]
                    },
                    upstream,
                    {},
                    {'anthropic-version': '2023-06-01'}
                );
            } else if (isResponsesWebSocketUpstream(upstream)) {
                let conn;
                try {
                    const result = await createResponsesWebSocket(
                        {
                            model,
                            input: 'hi',
                            max_output_tokens: 16
                        },
                        upstream,
                        {rejectUnauthorized: !upstream.skip_tls_verify}
                    );
                    conn = result.conn;
                    await waitForResponsesWebSocketCompleted(result.eventStream, this.testTimeoutMs, () => {
                        if (conn) discardResponsesWebSocketConnection(conn);
                    });
                    return {
                        success: true,
                        message: `连接成功 (protocol: ${upstream.protocol || 'responses_ws'}, model: ${model})`
                    };
                } finally {
                    if (conn) discardResponsesWebSocketConnection(conn);
                }
            } else if (isResponsesUpstream(upstream)) {
                response = await createResponses(
                    {
                        model,
                        input: 'hi',
                        max_output_tokens: 16,
                        stream: true
                    },
                    upstream
                );
            } else {
                response = await createChatCompletions(
                    {
                        model,
                        messages: [{role: 'user', content: 'hi'}],
                        max_tokens: 16,
                        stream: true
                    },
                    upstream
                );
            }
            if (response.status >= 200 && response.status < 300) {
                return {
                    success: true,
                    message: `连接成功 (protocol: ${upstream.protocol || 'openai'}, model: ${model})`
                };
            }
            return {success: false, message: `HTTP ${response.status}`};
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
