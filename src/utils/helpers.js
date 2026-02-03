/**
 * 通用辅助函数模块
 * @module utils/helpers
 */

/**
 * 生成随机 ID
 * @returns {string} 随机字符串 ID
 */
export function generateId() {
    return Math.random().toString(36).substring(2);
}

/**
 * 构建完整 URL
 * @param {string} baseUrl - 基础 URL
 * @param {string} endpoint - 端点路径
 * @returns {string} 完整 URL
 */
export function buildUrl(baseUrl, endpoint) {
    let finalUrl = baseUrl;
    let finalEndpoint = endpoint;

    // 确保 endpoint 不以 / 开头
    if (finalEndpoint.startsWith('/')) {
        finalEndpoint = finalEndpoint.slice(1);
    }

    // 提取 endpoint 中的版本号（如 v1/chat/completions -> v1）
    const endpointVersionMatch = finalEndpoint.match(/^(v\d+)\//);
    const endpointVersion = endpointVersionMatch ? endpointVersionMatch[1] : null;

    // 检查 baseUrl 末尾是否已有版本号
    const baseUrlVersionMatch = finalUrl.match(/\/(v\d+)\/?$/);
    const baseUrlVersion = baseUrlVersionMatch ? baseUrlVersionMatch[1] : null;

    // 如果 baseUrl 末尾的版本号与 endpoint 开头的版本号相同，移除 baseUrl 末尾的版本号
    if (baseUrlVersion && endpointVersion && baseUrlVersion === endpointVersion) {
        finalUrl = finalUrl.replace(/\/v\d+\/?$/, '');
    }

    // 确保 baseUrl 以 / 结尾
    if (!finalUrl.endsWith('/')) {
        finalUrl += '/';
    }

    const result = finalUrl + finalEndpoint;

    return result;
}

/**
 * 清理 JSON Schema，移除不兼容的属性
 * @param {object} schema - JSON Schema 对象
 * @returns {object} 清理后的 Schema
 */
export function cleanJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    // 检查是否需要创建新对象（是否有需要删除的属性）
    const needsCleanup = Object.keys(schema).some(key => 
        key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples' ||
        (key === 'format' && schema.type === 'string')
    );

    // 如果没有需要清理的属性，直接递归处理子对象
    if (!needsCleanup) {
        let hasChanges = false;
        const result = {...schema};
        
        for (const key in result) {
            if (key === 'properties' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (key === 'items' && typeof result[key] === 'object') {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            } else if (typeof result[key] === 'object' && !Array.isArray(result[key])) {
                const cleaned = cleanJsonSchema(result[key]);
                if (cleaned !== result[key]) {
                    result[key] = cleaned;
                    hasChanges = true;
                }
            }
        }
        
        return hasChanges ? result : schema;
    }

    // 需要删除属性，创建新对象
    const cleaned = {};
    
    for (const key in schema) {
        if (key === '$schema' || key === 'additionalProperties' || key === 'title' || key === 'examples') {
            // 跳过这些属性
            continue;
        }
        
        if (key === 'format' && schema.type === 'string') {
            // 跳过字符串类型的 format 属性
            continue;
        }
        
        if (key === 'enum' && Array.isArray(schema[key])) {
            // 保留 enum 数组
            cleaned[key] = schema[key];
        } else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (key === 'items' && typeof schema[key] === 'object') {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else if (typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
            cleaned[key] = cleanJsonSchema(schema[key]);
        } else {
            cleaned[key] = schema[key];
        }
    }
    
    return cleaned;
}
