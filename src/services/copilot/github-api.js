import {request, readBody} from '../../utils/http-client.js';
import {
    GITHUB_API_BASE_URL,
    GITHUB_APP_SCOPES,
    GITHUB_BASE_URL,
    GITHUB_CLIENT_ID,
    githubHeaders,
    standardHeaders
} from './config.js';

const DEFAULT_TIMEOUT = 20_000;

function networkOptions(options = {}) {
    return {
        timeout: options.timeout || DEFAULT_TIMEOUT,
        ...(options.proxyUrl ? {proxyUrl: options.proxyUrl} : {}),
        ...(typeof options.rejectUnauthorized === 'boolean'
            ? {rejectUnauthorized: options.rejectUnauthorized}
            : {})
    };
}

async function jsonRequest(url, options) {
    const response = await request(url, options);
    const body = await readBody(response.body, options.timeout || DEFAULT_TIMEOUT);
    let data;
    try {
        data = body ? JSON.parse(body) : {};
    } catch {
        throw new Error(`GitHub returned invalid JSON (${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
        throw new Error(data.message || `GitHub request failed: ${response.status}`);
    }
    return data;
}

export async function startDeviceAuth(options = {}) {
    const net = networkOptions(options);
    return jsonRequest(`${GITHUB_BASE_URL}/login/device/code`, {
        method: 'POST',
        headers: standardHeaders(),
        body: JSON.stringify({client_id: GITHUB_CLIENT_ID, scope: GITHUB_APP_SCOPES}),
        ...net
    });
}

export async function pollDeviceAuth(deviceCode, vsCodeVersion, options = {}) {
    const net = networkOptions(options);
    const tokenData = await jsonRequest(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        method: 'POST',
        headers: standardHeaders(),
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }),
        ...net
    });

    if (tokenData.error) {
        const error = new Error(tokenData.error_description || tokenData.error);
        error.code = tokenData.error;
        throw error;
    }
    if (!tokenData.access_token) throw new Error('GitHub response did not include an access token');

    const githubToken = tokenData.access_token;
    const userInfo = await getUser(githubToken, vsCodeVersion, options);
    const copilotToken = await getCopilotToken(githubToken, vsCodeVersion, options);
    return {githubToken, userInfo, copilotToken};
}

export function getUser(githubToken, vsCodeVersion, options = {}) {
    const net = networkOptions(options);
    return jsonRequest(`${GITHUB_API_BASE_URL}/user`, {
        method: 'GET',
        headers: githubHeaders(githubToken, vsCodeVersion),
        ...net
    });
}

export function getCopilotToken(githubToken, vsCodeVersion, options = {}) {
    const net = networkOptions(options);
    return jsonRequest(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
        method: 'GET',
        headers: githubHeaders(githubToken, vsCodeVersion),
        ...net
    });
}
