function normalizeHeaderValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeHeaderValue).find(Boolean) || null;
    }

    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized || null;
}

const PLACEHOLDER_AUTH_TOKENS = new Set(['dummy', 'codeagentsharedkey']);

function isPlaceholderAuthToken(apiKey) {
    return PLACEHOLDER_AUTH_TOKENS.has(apiKey.toLowerCase());
}

export function getHeaderValue(headers, name) {
    if (!headers) {
        return null;
    }

    const directValue = normalizeHeaderValue(headers[name]);
    if (directValue) {
        return directValue;
    }

    const normalizedName = name.toLowerCase();
    for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerName.toLowerCase() === normalizedName) {
            return normalizeHeaderValue(headerValue);
        }
    }

    return null;
}

export function extractTenantApiKey(headers) {
    const auth = getHeaderValue(headers, 'authorization');
    if (auth) {
        const bearerMatch = auth.match(/^Bearer\s+(.+)$/i);
        const apiKey = bearerMatch ? bearerMatch[1].trim() : auth;
        if (apiKey && !isPlaceholderAuthToken(apiKey)) {
            return apiKey;
        }
    }

    return getHeaderValue(headers, 'x-api-key');
}