import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticateApiKey} from '../src/services/gateway/gateway-auth.js';

function tenantManager(validKey) {
    return {
        isEnabled: () => true,
        authenticate: (apiKey) => apiKey === validKey ? 42 : null
    };
}

test('tenant auth accepts Claude Code ANTHROPIC_AUTH_TOKEN through Authorization bearer', () => {
    const headers = {authorization: 'Bearer sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('tenant auth accepts Claude Code ANTHROPIC_API_KEY through x-api-key', () => {
    const headers = {'x-api-key': 'sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('CodeBuddy and Relay accept legacy ANTHROPIC_CUSTOM_HEADERS x-api-key case-insensitively', () => {
    const headers = {'X-API-Key': 'sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('CodeBuddy and Relay accept legacy x-api-key when ANTHROPIC_AUTH_TOKEN is dummy', () => {
    const headers = {authorization: 'Bearer dummy', 'x-api-key': 'sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('CodeBuddy and Relay accept legacy x-api-key when ANTHROPIC_AUTH_TOKEN is CodeAgentSharedKey', () => {
    const headers = {authorization: 'Bearer CodeAgentSharedKey', 'x-api-key': 'sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('CodeBuddy and Relay accept Authorization bearer case-insensitively', () => {
    const headers = {Authorization: 'bearer sk-valid'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});

test('Authorization bearer takes precedence over x-api-key compatibility header', () => {
    const headers = {authorization: 'Bearer sk-valid', 'x-api-key': 'sk-stale'};

    assert.deepEqual(authenticateApiKey(headers, tenantManager('sk-valid')), {tenantId: 42});
});
