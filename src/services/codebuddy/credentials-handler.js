export function createCodebuddyCredentialsHandler({
    resolveTenantManager,
    credentialService,
    sendOpenAIError,
    sendJson,
    upstreamErrorStatus,
    parseBody,
    getCodebuddyBaseUrl,
    blockedDomains,
    logger = console
}) {
    async function handleCredentials(req, res, method, pathname) {
        try {
            if (method === 'GET' && pathname === '/v1/credentials') {
                const resolved = await resolveTenantManager(req);
                if (resolved.error) {
                    sendOpenAIError(res, resolved.error.status, resolved.error.message);
                    return;
                }
                const credentials = resolved.manager.getCredentialsInfo();
                sendJson(res, 200, {credentials});
                return;
            }

            if (method === 'GET' && pathname === '/v1/credentials/current') {
                const resolved = await resolveTenantManager(req);
                if (resolved.error) {
                    sendOpenAIError(res, resolved.error.status, resolved.error.message);
                    return;
                }
                const info = resolved.manager.getCurrentCredentialInfo();
                sendJson(res, 200, info);
                return;
            }

            if (method === 'POST' && pathname === '/v1/credentials') {
                const body = await parseBody(req);
                const data = JSON.parse(body);

                if (!data.bearer_token) {
                    sendOpenAIError(res, 400, 'bearer_token is required');
                    return;
                }

                const credentialHost = new URL(getCodebuddyBaseUrl(data.base_url)).host;
                if (blockedDomains.includes(credentialHost)) {
                    sendOpenAIError(res, 400, `Domain ${credentialHost} is deprecated and cannot be added`);
                    return;
                }

                const resolved = await resolveTenantManager(req);
                if (resolved.error) {
                    sendOpenAIError(res, resolved.error.status, resolved.error.message);
                    return;
                }
                const success = await resolved.manager.addCredentialWithData(data, data.filename);
                if (success) {
                    credentialService.syncCredentialCount(resolved.tenantId);
                    sendJson(res, 200, {message: 'Credential added successfully'});
                } else {
                    sendOpenAIError(res, 500, 'Failed to save credential');
                }
                return;
            }

            if (method === 'POST' && pathname === '/v1/credentials/select') {
                const body = await parseBody(req);
                const data = JSON.parse(body);

                if (data.index === undefined || data.index === null) {
                    sendOpenAIError(res, 400, 'index is required');
                    return;
                }

                const resolved = await resolveTenantManager(req);
                if (resolved.error) {
                    sendOpenAIError(res, resolved.error.status, resolved.error.message);
                    return;
                }
                const success = await resolved.manager.setActiveCredential(data.index);
                if (success) {
                    sendJson(res, 200, {message: `Credential #${data.index + 1} set as active`});
                } else {
                    sendOpenAIError(res, 400, 'Invalid credential index');
                }
                return;
            }

            if (method === 'POST' && pathname === '/v1/credentials/delete') {
                const body = await parseBody(req);
                const data = JSON.parse(body);

                if (data.index === undefined || data.index === null) {
                    sendOpenAIError(res, 400, 'index is required');
                    return;
                }

                const resolved = await resolveTenantManager(req);
                if (resolved.error) {
                    sendOpenAIError(res, resolved.error.status, resolved.error.message);
                    return;
                }
                const success = await resolved.manager.deleteCredential(data.index);
                if (success) {
                    credentialService.syncCredentialCount(resolved.tenantId);
                    sendJson(res, 200, {message: `Credential #${data.index + 1} deleted successfully`});
                } else {
                    sendOpenAIError(res, 400, 'Invalid index or failed to delete credential');
                }
                return;
            }

            sendOpenAIError(res, 404, 'Credential endpoint not found');
        } catch (error) {
            logger.error('Credential management error:', error);
            sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Internal server error');
        }
    }

    return handleCredentials;
}
