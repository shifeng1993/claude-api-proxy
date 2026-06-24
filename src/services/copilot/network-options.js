export function extractCopilotProxyFromHeaders(req, store) {
    const storeProxy = store.getProxyUrl();
    if (storeProxy) return storeProxy;

    const proxy = req.headers['x-copilot-proxy'];
    if (!proxy) return undefined;
    const remoteAddr = req.socket?.remoteAddress || '';
    if (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') {
        return proxy;
    }
    return undefined;
}

export function createCopilotNetworkOptionsResolver({store}) {
    return function getCopilotNetworkOptions(req) {
        return {
            proxyUrl: extractCopilotProxyFromHeaders(req, store),
            rejectUnauthorized: store.getRejectUnauthorized()
        };
    };
}
