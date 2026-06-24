/**
 * CodeBuddy tenant credential service.
 * @module services/codebuddy/credential-service
 */

import {TenantTokenManager} from './tenant-token-manager.js';

const serviceCache = new WeakMap();

export class CodebuddyCredentialService {
    constructor({tenantManager, tokenManagerClass = TenantTokenManager} = {}) {
        if (!tenantManager) {
            throw new Error('CodebuddyCredentialService requires a tenantManager');
        }
        this.tenantManager = tenantManager;
        this.tokenManagerClass = tokenManagerClass;
        /** @type {Map<number, TenantTokenManager>} */
        this.managerCache = new Map();
    }

    _tenantId(tenantId) {
        return typeof tenantId === 'string' ? parseInt(tenantId, 10) : tenantId;
    }

    _hasTenant(tenantId) {
        if (typeof this.tenantManager.getTenant === 'function') {
            return !!this.tenantManager.getTenant(tenantId);
        }
        if (this.tenantManager.tenantsCache instanceof Map) {
            return this.tenantManager.tenantsCache.has(tenantId);
        }
        return true;
    }

    async getCredentialManager(tenantId) {
        const id = this._tenantId(tenantId);
        if (!this._hasTenant(id)) return null;
        if (this.managerCache.has(id)) {
            const manager = this.managerCache.get(id);
            await manager.loadAllTokens();
            await manager.loadState();
            return manager;
        }
        const manager = await this.tokenManagerClass.create(null, {tenantId: id});
        this.managerCache.set(id, manager);
        return manager;
    }

    async listCredentials(tenantId) {
        const manager = await this.getCredentialManager(tenantId);
        if (!manager) return {credentials: [], activeIndex: -1};
        return {
            credentials: manager.credentials.map((credential, index) => ({
                id: credential.id,
                index,
                enabled: !manager.disabledIndexes.includes(index),
                ...credential.data
            })),
            activeIndex: manager.currentIndex
        };
    }

    async refreshCredentials(tenantId) {
        const id = this._tenantId(tenantId);
        const manager = this.managerCache.get(id);
        if (!manager) return;
        await manager.loadAllTokens();
        await manager.loadState();
    }

    syncCredentialCount(tenantId) {
        return this.refreshCredentials(tenantId);
    }

    reloadCredentialCache(tenantId) {
        return this.refreshCredentials(tenantId);
    }
}

export function createCodebuddyCredentialService(options) {
    return new CodebuddyCredentialService(options);
}

export function getCodebuddyCredentialService(tenantManager) {
    if (!serviceCache.has(tenantManager)) {
        serviceCache.set(tenantManager, createCodebuddyCredentialService({tenantManager}));
    }
    return serviceCache.get(tenantManager);
}
