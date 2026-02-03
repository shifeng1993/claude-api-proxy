/**
 * Transformer 服务
 * 参考 claude-code-router 架构
 */

// 导入默认的 Transformer 集合
import Transformers from '../transformer/index.js';

/**
 * Transformer 服务类
 * 管理所有 Transformer 的注册和获取
 */
export class TransformerService {
    /**
     * 构造函数
     * @param {Object} logger - 日志记录器
     */
    constructor(logger) {
        this.transformers = new Map();
        this.logger = logger || console;
    }

    /**
     * 注册 Transformer
     * @param {string} name - Transformer 名称
     * @param {Object} transformer - Transformer 实例或构造函数
     */
    registerTransformer(name, transformer) {
        this.transformers.set(name, transformer);
        this.logger.info(
            `register transformer: ${name}${
                transformer.endPoint
                    ? ` (endpoint: ${transformer.endPoint})`
                    : ' (no endpoint)'
            }`
        );
    }

    /**
     * 获取 Transformer
     * @param {string} name - Transformer 名称
     * @returns {Object|undefined} Transformer 实例或构造函数
     */
    getTransformer(name) {
        return this.transformers.get(name);
    }

    /**
     * 获取所有 Transformer
     * @returns {Map<string, Object>} Transformer 映射表
     */
    getAllTransformers() {
        return new Map(this.transformers);
    }

    /**
     * 获取有端点的 Transformer
     * @returns {Array<{name: string, transformer: Object}>} 有端点的 Transformer 列表
     */
    getTransformersWithEndpoint() {
        const result = [];

        this.transformers.forEach((transformer, name) => {
            // 检查是否为实例且具有端点
            if (typeof transformer === 'object' && transformer.endPoint) {
                result.push({ name, transformer });
            }
        });

        return result;
    }

    /**
     * 获取没有端点的 Transformer
     * @returns {Array<{name: string, transformer: Object}>} 没有端点的 Transformer 列表
     */
    getTransformersWithoutEndpoint() {
        const result = [];

        this.transformers.forEach((transformer, name) => {
            // 检查是否为实例且没有端点
            if (typeof transformer === 'object' && !transformer.endPoint) {
                result.push({ name, transformer });
            }
        });

        return result;
    }

    /**
     * 移除 Transformer
     * @param {string} name - Transformer 名称
     * @returns {boolean} 是否成功移除
     */
    removeTransformer(name) {
        return this.transformers.delete(name);
    }

    /**
     * 检查是否存在 Transformer
     * @param {string} name - Transformer 名称
     * @returns {boolean} 是否存在
     */
    hasTransformer(name) {
        return this.transformers.has(name);
    }

    /**
     * 从配置注册 Transformer
     * @param {Object} config - Transformer 配置
     * @returns {Promise<boolean>} 是否成功注册
     */
    async registerTransformerFromConfig(config) {
        try {
            if (config.path) {
                // 动态导入模块
                const module = await import(config.path);
                if (module) {
                    const instance = new module.default(config.options);
                    // 为 Transformer 实例设置日志记录器
                    if (instance && typeof instance === 'object') {
                        instance.logger = this.logger;
                    }
                    if (!instance.name) {
                        throw new Error(
                            `Transformer instance from ${config.path} does not have a name property.`
                        );
                    }
                    this.registerTransformer(instance.name, instance);
                    return true;
                }
            }
            return false;
        } catch (error) {
            this.logger.error(
                `load transformer (${config.path}) \nerror: ${error.message}\nstack: ${error.stack}`
            );
            return false;
        }
    }

    /**
     * 初始化 Transformer 服务
     * 注册默认的 Transformer
     */
    async initialize() {
        try {
            await this.registerDefaultTransformers();
        } catch (error) {
            this.logger.error(
                `TransformerService init error: ${error.message}\nStack: ${error.stack}`
            );
        }
    }

    /**
     * 注册默认的 Transformer
     * @private
     */
    async registerDefaultTransformers() {
        try {
            Object.values(Transformers).forEach((TransformerStatic) => {
                if (
                    TransformerStatic.TransformerName &&
                    typeof TransformerStatic.TransformerName === 'string'
                ) {
                    // 类有静态 TransformerName 属性
                    this.registerTransformer(
                        TransformerStatic.TransformerName,
                        TransformerStatic
                    );
                } else {
                    // 创建实例
                    const transformerInstance = new TransformerStatic();
                    // 为实例设置日志记录器
                    if (transformerInstance && typeof transformerInstance === 'object') {
                        transformerInstance.logger = this.logger;
                    }
                    this.registerTransformer(
                        transformerInstance.name,
                        transformerInstance
                    );
                }
            });
        } catch (error) {
            this.logger.error({ error }, 'transformer register error:');
        }
    }

    /**
     * 从配置加载 Transformer
     * @param {Array<Object>} transformersConfig - Transformer 配置数组
     */
    async loadFromConfig(transformersConfig = []) {
        for (const transformer of transformersConfig) {
            await this.registerTransformerFromConfig(transformer);
        }
    }
}

// 默认导出
export default TransformerService;