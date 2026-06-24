import {
    acquire as acquireShared,
    release,
    discard,
    shutdown,
    sendRequest
} from '../shared/index.js';
import {getCopilotBaseUrl, wsHeaders} from './config.js';

export async function acquire(
    copilotToken,
    vsCodeVersion,
    accountType = 'individual',
    agent,
    rejectUnauthorized = true,
    contextKey,
    preferredPreviousResponseId,
    networkKey
) {
    const baseUrl = getCopilotBaseUrl(accountType);
    const url = `${baseUrl.replace(/^http/, 'ws')}/responses`;
    return acquireShared({
        url,
        headers: wsHeaders(copilotToken, vsCodeVersion),
        authKey: copilotToken,
        agent,
        rejectUnauthorized,
        contextKey,
        preferredPreviousResponseId,
        networkKey
    });
}

export {release, discard, shutdown, sendRequest};
