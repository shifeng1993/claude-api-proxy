/**
 * 请求路由解析模块
 * @module router
 */

/**
 * 解析请求路径
 * @param {string} pathname - URL 路径
 * @returns {{ typeParam?: string, baseUrl?: string, error?: { status: number, message: string } }}
 */
export function parsePath(pathname) {
    const pathParts = pathname.split('/').filter((part) => part !== '');

    if (pathParts.length < 3) {
        return {
            error: {
                status: 400,
                message: 'Invalid path format. Expected: /{type}/{provider_url}/v1/messages'
            }
        };
    }

    const lastTwoParts = pathParts.slice(-2);
    if (lastTwoParts[0] !== 'v1' || lastTwoParts[1] !== 'messages') {
        return {
            error: {
                status: 404,
                message: 'Path must end with /v1/messages'
            }
        };
    }

    const typeParam = pathParts[0];
    const providerUrlParts = pathParts.slice(1, -2);

    // 处理 http: 或 https: 协议
    if (providerUrlParts[0] && providerUrlParts[0].startsWith('http')) {
        providerUrlParts[0] = providerUrlParts[0] + '/';
    }

    const baseUrl = providerUrlParts.join('/');

    if (!typeParam || !baseUrl) {
        return {
            error: {
                status: 400,
                message: 'Missing type or provider_url in path'
            }
        };
    }

    return {typeParam, baseUrl};
}

/**
 * 从请求头中提取 API Key
 * @param {object} headers - 请求头对象
 * @returns {{ apiKey?: string, mutatedHeaders?: object, error?: { status: number, message: string } }}
 */
export function getApiKey(headers) {
    const mutatedHeaders = {...headers};
    let apiKey = headers['x-api-key'];

    if (apiKey) {
        delete mutatedHeaders['x-api-key'];
    } else {
        apiKey = headers['authorization'];
        if (apiKey) {
            delete mutatedHeaders['authorization'];
        }
    }

    if (!apiKey) {
        return {
            error: {
                status: 401,
                message: 'Missing x-api-key or authorization header'
            }
        };
    }

    return {apiKey, mutatedHeaders};
}

/**
 * 路由匹配结果
 * @typedef {object} RouteMatch
 * @property {string} type - Provider 类型
 * @property {string} baseUrl - 基础 URL
 * @property {string} apiKey - API Key
 * @property {object} headers - 处理后的请求头
 */

/**
 * 完整路由解析
 * @param {string} pathname - URL 路径
 * @param {object} headers - 请求头对象
 * @returns {{ match?: RouteMatch, error?: { status: number, message: string } }}
 */
export function parseRoute(pathname, headers) {
    const pathResult = parsePath(pathname);
    if (pathResult.error) {
        return {error: pathResult.error};
    }

    const apiKeyResult = getApiKey(headers);
    if (apiKeyResult.error) {
        return {error: apiKeyResult.error};
    }

    return {
        match: {
            type: pathResult.typeParam,
            baseUrl: pathResult.baseUrl,
            apiKey: apiKeyResult.apiKey,
            headers: apiKeyResult.mutatedHeaders
        }
    };
}
