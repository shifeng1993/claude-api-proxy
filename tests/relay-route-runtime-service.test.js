import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelayRouteRuntime} from '../src/services/relay/route-runtime.js';

test('createRelayRouteRuntime exposes route-facing relay handlers and helpers', () => {
    const tenantManager = {
        isEnabled: () => true
    };
    const logger = {error: () => {}, warn: () => {}, info: () => {}};
    const runtime = createRelayRouteRuntime({tenantManager, logger});

    assert.equal(runtime.isTenantEnabled(), true);
    for (const key of [
        'sendJson',
        'sendOpenAIError',
        'sendAnthropicError',
        'getDiagnostics',
        'handleOpenAIModels',
        'handleAnthropicModels',
        'handleAnthropicCountTokens',
        'handleOpenAIChatCompletions',
        'handleAnthropicMessages',
        'handleResponsesAPI',
        'handleResponsesCompact',
        'handleRelayResponsesWS'
    ]) {
        assert.equal(typeof runtime[key], 'function', key);
    }
});
