import {resolveCredential as defaultResolveCredential} from '../gateway/index.js';

function listCredentialRecords(credentialService, tenantId) {
    if (typeof credentialService.listCredentials === 'function') {
        return credentialService.listCredentials(tenantId);
    }
    return {credentials: [], activeIndex: -1};
}

function getCredentialManager(credentialService, tenantId) {
    if (typeof credentialService.getCredentialManager === 'function') {
        return credentialService.getCredentialManager(tenantId);
    }
    return null;
}

export async function resolveCodebuddyCredentialContext({
    req,
    credentialService,
    resolveCredential = defaultResolveCredential
}) {
    const tenantId = req.tenantId;
    if (!tenantId) {
        return {error: {status: 503, message: 'CodeBuddy tenant system is not enabled'}};
    }

    const {credentials, activeIndex} = await listCredentialRecords(credentialService, tenantId);

    const credential = resolveCredential(req.headers, credentials, activeIndex);

    if (!credential) {
        return {error: {status: 503, message: 'No available credentials for tenant'}};
    }

    return {credential, tenantId};
}

export function createCodebuddyCredentialResolver({
    credentialService,
    resolveCredential = defaultResolveCredential
}) {
    return (req) => resolveCodebuddyCredentialContext({
        req,
        credentialService,
        resolveCredential
    });
}

export async function resolveCodebuddyTenantCredentialManager({req, credentialService}) {
    const tenantId = req.tenantId;
    if (!tenantId) return {error: {status: 401, message: 'Unauthorized'}};
    const manager = await getCredentialManager(credentialService, tenantId);
    if (!manager) return {error: {status: 404, message: 'Tenant credential manager not available'}};
    return {manager, tenantId};
}

export function createCodebuddyTenantCredentialManagerResolver({credentialService}) {
    return (req) => resolveCodebuddyTenantCredentialManager({req, credentialService});
}
