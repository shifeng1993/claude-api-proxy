export function createCopilotAuthResolver({
    isAuthenticated,
    ensureCopilotToken,
    store
}) {
    return async function ensureCopilotAuth(networkOptions = {}) {
        if (!isAuthenticated()) {
            return {
                error: {
                    status: 401,
                    message: 'Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.'
                }
            };
        }

        try {
            const proxyUrl = 'proxyUrl' in networkOptions ? networkOptions.proxyUrl : store.getProxyUrl();
            const copilotToken = await ensureCopilotToken(proxyUrl, networkOptions);
            return {copilotToken};
        } catch (error) {
            return {error: {status: 503, message: error.message}};
        }
    };
}
