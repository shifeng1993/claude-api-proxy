import {copilotCredentialManager} from './credential-manager.js';
import {currentCopilotContext} from './runtime.js';

export function isAuthenticated() {
    return !!currentCopilotContext().credential.github_token;
}

export async function ensureCopilotToken() {
    const context = currentCopilotContext();
    const result = await copilotCredentialManager.ensureToken(
        context.tenantId,
        context.credential.id
    );
    context.credential = result.credential;
    return result.token;
}
