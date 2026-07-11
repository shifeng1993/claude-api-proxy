import {randomBytes} from 'crypto';

/**
 * Generic helper utilities.
 * @module utils/helpers
 */

export function generateId(prefix) {
    const id = randomBytes(16).toString('hex');
    return prefix ? `${prefix}_${id}` : id;
}

/**
 * 读取并解析 JSON 请求体，带大小限制防止内存耗尽攻击
 * 超限时抛出带 status=413 的错误
 * @param {import('http').IncomingMessage} req
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<object>}
 */
export function readJsonBody(req, {maxBytes = 1024 * 1024} = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        const onData = (chunk) => {
            if (aborted) return;
            size += chunk.length;
            if (size > maxBytes) {
                aborted = true;
                req.off('data', onData);
                req.off('end', onEnd);
                req.off('error', onError);
                req.pause();
                const err = new Error(`Request body exceeds ${maxBytes} bytes limit`);
                err.status = 413;
                reject(err);
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => {
            if (aborted) return;
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch (e) { reject(e); }
        };
        const onError = (err) => { if (!aborted) reject(err); };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
    });
}

export function buildUrl(baseUrl, endpoint) {
    let finalUrl = baseUrl;
    let finalEndpoint = endpoint;

    if (finalEndpoint.startsWith('/')) {
        finalEndpoint = finalEndpoint.slice(1);
    }

    if (!finalUrl.endsWith('/')) {
        finalUrl += '/';
    }

    let url = finalUrl + finalEndpoint;
    let prev;
    do {
        prev = url;
        url = url.replace(/\/(v\d+)\/v\d+\//g, '/$1/');
    } while (url !== prev);
    return url;
}
