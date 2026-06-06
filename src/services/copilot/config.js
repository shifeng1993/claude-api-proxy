import {randomBytes} from 'crypto';

export const COPILOT_VERSION = '0.26.7';
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
export const API_VERSION = '2025-04-01';
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_BASE_URL = 'https://github.com';
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const GITHUB_APP_SCOPES = 'read:user';
export const DEFAULT_VSCODE_VERSION = '1.109.2';

export function getCopilotBaseUrl(accountType = 'individual') {
    return accountType === 'individual'
        ? 'https://api.githubcopilot.com'
        : `https://api.${accountType}.githubcopilot.com`;
}

export function generateUUID() {
    return randomBytes(16).toString('hex').replace(
        /(.{8})(.{4})(.{4})(.{4})(.{12})/,
        '$1-$2-$3-$4-$5'
    );
}

export function standardHeaders() {
    return {'content-type': 'application/json', accept: 'application/json'};
}

export function githubHeaders(githubToken, vsCodeVersion = DEFAULT_VSCODE_VERSION) {
    return {
        ...standardHeaders(),
        authorization: `Bearer ${githubToken}`,
        'editor-version': `vscode/${vsCodeVersion}`,
        'editor-plugin-version': EDITOR_PLUGIN_VERSION,
        'user-agent': USER_AGENT
    };
}

export function copilotHeaders(copilotToken, vsCodeVersion = DEFAULT_VSCODE_VERSION, vision = false) {
    const headers = {
        Authorization: `Bearer ${copilotToken}`,
        'content-type': 'application/json',
        'copilot-integration-id': 'vscode-chat',
        'editor-version': `vscode/${vsCodeVersion}`,
        'editor-plugin-version': EDITOR_PLUGIN_VERSION,
        'user-agent': USER_AGENT,
        'openai-intent': 'conversation-panel',
        'x-github-api-version': API_VERSION,
        'x-request-id': generateUUID(),
        'x-vscode-user-agent-library-version': 'electron-fetch'
    };
    if (vision) headers['copilot-vision-request'] = 'true';
    return headers;
}

export function wsHeaders(copilotToken, vsCodeVersion = DEFAULT_VSCODE_VERSION) {
    const requestId = generateUUID();
    return {
        Authorization: `Bearer ${copilotToken}`,
        'OpenAI-Intent': 'conversation-agent',
        'X-GitHub-Api-Version': API_VERSION,
        'X-Request-Id': requestId,
        'X-Interaction-Id': requestId,
        'X-Interaction-Type': 'conversation-agent',
        'X-Agent-Task-Id': requestId,
        'Editor-Version': `vscode/${vsCodeVersion}`,
        'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
        'Editor-Device-Id': generateUUID(),
        'User-Agent': 'node',
        'Copilot-Integration-Id': 'vscode-chat',
        'VScode-SessionId': `${generateUUID()}${Date.now()}`,
        'VScode-MachineId': generateUUID()
    };
}
