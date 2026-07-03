import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readdir, stat} from 'node:fs/promises';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const servicesRoot = path.join(repoRoot, 'src', 'services');
const routesRoot = path.join(repoRoot, 'src', 'routes');
const sharedServicesRoot = path.join(servicesRoot, 'shared');

async function listJsFiles(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    const nested = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return listJsFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    }));
    return nested.flat();
}

async function listTextFiles(target, extensions = new Set(['.js', '.html', '.md', '.json'])) {
    const targetStat = await stat(target);
    if (targetStat.isFile()) {
        return extensions.has(path.extname(target)) ? [target] : [];
    }
    const entries = await readdir(target, {withFileTypes: true});
    const nested = await Promise.all(entries.map((entry) => {
        const fullPath = path.join(target, entry.name);
        return entry.isDirectory()
            ? listTextFiles(fullPath, extensions)
            : extensions.has(path.extname(entry.name)) ? [fullPath] : [];
    }));
    return nested.flat();
}

test('product services name protocol shims as adapters instead of translators', async () => {
    const files = await listJsFiles(servicesRoot);
    const forbiddenFiles = files
        .map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
        .filter((file) => /(?:^|\/)(?:.*-)?translator\.js$/.test(path.basename(file)));

    assert.deepEqual(forbiddenFiles, []);
});

test('product protocol entry files live under business protocol directories', async () => {
    const expectedFiles = [
        'src/protocol-engine/core/chat/index.js',
        'src/services/relay/protocols/chat/completions.js',
        'src/services/relay/protocols/chat/outbound.js',
        'src/services/relay/protocols/anthropic/messages.js',
        'src/services/relay/protocols/responses/http.js',
        'src/services/relay/protocols/responses/compact.js',
        'src/services/relay/protocols/responses/websocket.js',
        'src/services/codebuddy/protocols/chat/completions.js',
        'src/services/codebuddy/protocols/chat/outbound.js',
        'src/services/codebuddy/protocols/anthropic/messages.js',
        'src/services/codebuddy/protocols/responses/http.js',
        'src/services/codebuddy/protocols/responses/compact.js',
        'src/services/codebuddy/protocols/responses/websocket.js',
    ];
    const legacyFiles = [
        'src/protocol-engine/core/chat-upstream.js',
        'src/services/relay/chat-completions-handler.js',
        'src/services/relay/outbound-chat.js',
        'src/services/relay/anthropic-messages-handler.js',
        'src/services/relay/responses-api-handler.js',
        'src/services/relay/responses-compact-handler.js',
        'src/services/relay/responses-websocket-handler.js',
        'src/services/codebuddy/chat-completions-handler.js',
        'src/services/codebuddy/outbound-chat.js',
        'src/services/codebuddy/anthropic-messages-handler.js',
        'src/services/codebuddy/responses-api-handler.js',
        'src/services/codebuddy/responses-compact-handler.js',
        'src/services/codebuddy/responses-websocket-handler.js',
    ];

    const missingExpected = expectedFiles.filter((file) => !existsSync(path.join(repoRoot, file)));
    const staleLegacy = legacyFiles.filter((file) => existsSync(path.join(repoRoot, file)));

    assert.deepEqual({missingExpected, staleLegacy}, {missingExpected: [], staleLegacy: []});
});

test('retired third product surface stays removed', async () => {
    const retired = ['co', 'pilot'].join('');
    const removedEntrypoints = [
        path.join(repoRoot, 'src', 'routes', `${retired}.js`),
        path.join(repoRoot, 'src', 'routes', `dashboard-${retired}.js`),
        path.join(repoRoot, 'src', 'services', retired)
    ];
    const staleEntrypoints = removedEntrypoints
        .filter((entry) => existsSync(entry))
        .map((entry) => path.relative(repoRoot, entry).replaceAll('\\', '/'));

    const scannedRoots = [
        path.join(repoRoot, 'src'),
        path.join(repoRoot, 'docs'),
        path.join(repoRoot, 'README.md'),
        path.join(repoRoot, 'package.json')
    ];
    const scannedFiles = (await Promise.all(scannedRoots.map((target) => listTextFiles(target)))).flat();
    const staleReferences = [];
    for (const file of scannedFiles) {
        const source = await readFile(file, 'utf8');
        if (source.toLowerCase().includes(retired)) {
            staleReferences.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual({staleEntrypoints, staleReferences}, {staleEntrypoints: [], staleReferences: []});
});

test('routes do not depend on another product service API for shared helpers', async () => {
    const checkedRoutes = [
        'src/routes/relay.js',
    ];
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8');
        if (/services\/codebuddy\/api\.js/.test(source.replaceAll('\\', '/'))) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
});

test('product services receive gateway helpers through injection', async () => {
    const productServiceDirs = ['relay', 'codebuddy'];
    const gatewayImport =
        /from\s+['"][^'"]*(?:services\/gateway|\.\.\/gateway|\.\.\/\.\.\/gateway)[^'"]*['"]/;
    const violations = [];

    for (const dir of productServiceDirs) {
        const files = await listJsFiles(path.join(servicesRoot, dir));
        for (const file of files) {
            const source = await readFile(file, 'utf8').then((text) => text.replaceAll('\\', '/'));
            if (gatewayImport.test(source)) {
                violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
            }
        }
    }

    assert.deepEqual(violations, []);
});

test('product services avoid gateway singleton naming leakage', async () => {
    const productServiceDirs = ['relay', 'codebuddy'];
    const violations = [];

    for (const dir of productServiceDirs) {
        const files = await listJsFiles(path.join(servicesRoot, dir));
        for (const file of files) {
            const source = await readFile(file, 'utf8');
            if (/\bunifiedTenantManager\b/.test(source)) {
                violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
            }
        }
    }

    assert.deepEqual(violations, []);
});

test('auth routes use gateway public auth boundary instead of shared auth internals', async () => {
    const checkedRoutes = [
        'src/routes/auth.js',
        'src/routes/dashboard-users.js',
        'src/routes/dashboard-frontend.js'
    ];
    const privateSharedAuthImport = /services\/shared\/(?:auth-mode|local-auth|ldap-auth)\.js/;
    const codebuddyAuthImport = /services\/codebuddy\/ldap-auth\.js/;
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8')
            .then((text) => text.replaceAll('\\', '/'));
        if (privateSharedAuthImport.test(source) || codebuddyAuthImport.test(source)) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
    await assert.rejects(
        stat(path.join(repoRoot, 'src', 'services', 'codebuddy', 'ldap-auth.js')),
        {code: 'ENOENT'}
    );
});

test('app entry imports authentication through gateway public boundary', async () => {
    const source = await readFile(path.join(repoRoot, 'src/index.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /services\/shared\/(?:auth-mode|local-auth|ldap-auth)\.js/);
    assert.match(source, /services\/gateway\/index\.js/);
});

test('legacy unused runtime helper files stay removed', async () => {
    const removedFiles = [
        'src/services/relay/config.js',
        'src/utils/circular-buffer.js'
    ];
    const stillPresent = [];

    for (const file of removedFiles) {
        try {
            await stat(path.join(repoRoot, file));
            stillPresent.push(file);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }

    assert.deepEqual(stillPresent, []);
});

test('product APIs do not re-export provider stream helpers', async () => {
    const checkedApis = [
        'src/services/codebuddy/api.js'
    ];
    const violations = [];

    for (const api of checkedApis) {
        const source = await readFile(path.join(repoRoot, api), 'utf8');
        if (/providers\/stream-response\.js/.test(source.replaceAll('\\', '/'))) {
            violations.push(api);
        }
    }

    assert.deepEqual(violations, []);
});

test('app layers import protocol engine through the public boundary', async () => {
    const files = [
        ...await listJsFiles(servicesRoot),
        ...await listJsFiles(routesRoot)
    ];
    const deepProtocolImport = /from\s+['"][^'"]*core\/protocol\/(?:shared|responses|http-converters|canonical|stream|diagnostics|schema)[^'"]*['"]/;
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8').then((text) => text.replaceAll('\\', '/'));
        if (deepProtocolImport.test(source)) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('routes use product protocol adapters instead of protocol core directly', async () => {
    const files = await listJsFiles(routesRoot);
    const violations = [];

    for (const file of files) {
        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*core\/protocol\/index\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('protocol routes use public service boundaries for providers session and shared helpers', async () => {
    const checkedRoutes = [
        'src/routes/relay.js',
        'src/routes/codebuddy.js'
    ];
    const privateServiceImports = /services\/(?:providers\/(?:upstream-api|stream-response|upstream-manager)|session\/(?:conversation-state|context-compactor|responses-continuation)|shared\/(?:responses-ws-client|responses-ws-server))\.js/;
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8');
        if (privateServiceImports.test(source.replaceAll('\\', '/'))) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
});

test('services import Responses WebSocket shared helpers through the shared boundary', async () => {
    const files = await listJsFiles(servicesRoot);
    const privateSharedResponsesWsImport =
        /from\s+['"][^'"]*(?:services\/shared|\.{1,2}\/shared)\/responses-ws-(?:client|server|pool|mode)\.js['"]/;
    const violations = [];

    for (const file of files) {
        const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
        if (relative.startsWith('src/services/shared/')) continue;

        const source = await readFile(file, 'utf8').then((text) => text.replaceAll('\\', '/'));
        if (privateSharedResponsesWsImport.test(source)) {
            violations.push(relative);
        }
    }

    assert.deepEqual(violations, []);
});

test('product services expose route runtime factories from public boundaries', async () => {
    const relay = await import(pathToFileURL(path.join(servicesRoot, 'relay', 'index.js')).href);
    const codebuddy = await import(pathToFileURL(path.join(servicesRoot, 'codebuddy', 'index.js')).href);
    
    assert.equal(typeof relay.createRelayRouteRuntime, 'function');
    assert.equal(typeof codebuddy.createCodebuddyRouteRuntime, 'function');
});

test('protocol routes import product services through public boundaries', async () => {
    const checkedRoutes = [
        'src/routes/relay.js',
        'src/routes/codebuddy.js'
    ];
    const privateProductRuntimeImport =
        /from\s+['"][^'"]*services\/(?:relay|codebuddy)\/route-runtime\.js['"]/;
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8').then((text) => text.replaceAll('\\', '/'));
        if (privateProductRuntimeImport.test(source)) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
});

test('dashboard routes import product services through public boundaries', async () => {
    const checkedRoutes = [
        'src/routes/dashboard-codebuddy.js',
        'src/routes/dashboard-frontend.js'
    ];
    const privateProductImport =
        /from\s+['"][^'"]*services\/(?:codebuddy)\/(?!index\.js['"])[^'"]+['"]/;
    const violations = [];

    for (const route of checkedRoutes) {
        const source = await readFile(path.join(repoRoot, route), 'utf8').then((text) => text.replaceAll('\\', '/'));
        if (privateProductImport.test(source)) {
            violations.push(route);
        }
    }

    assert.deepEqual(violations, []);
});

test('dashboard frontend route delegates usage persistence to gateway service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/dashboard-frontend.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /db\/models|from\s+['"]sequelize['"]|\bmodels\./);
});

test('stats route delegates tenant credential lookups to gateway service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/stats.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /db\/models\/index\.js|\bmodels\./);
});

test('stats route delegates usage aggregation to gateway service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/stats.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /db\/models|from\s+['"]sequelize['"]|\bTenantDailyUsage\b/);
});

test('feedback admin route delegates feedback persistence to feedback service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/feedback-admin.js'), 'utf8')
        .then((text) => text.replaceAll('\\', '/'));

    assert.doesNotMatch(source, /db\/models|from\s+['"]sequelize['"]|\bFeedback\./);
});

test('relay route delegates usage and upstream context orchestration to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bunifiedTenantManager\.(?:incrementApiCallCount|incrementTokenUsage|recordDailyUsage|getUpstreamManager)\b/,
        /from\s+['"][^'"]*utils\/http-client\.js['"]/,
        /\b(?:ProviderUpstreamError|normalizeUpstreamProtocol|readBody|isNetworkError)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates response state orchestration to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\brecordResponsesResponse\s*\(/,
        /\blimitResponsesInputItems\b/,
        /\b(?:async\s+)?function\s+(?:recordCompletedResponseState|limitResponsesPassthroughPayload|collectResponsesWebSocketResponse)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates body and SSE parsing helpers to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\b(?:async\s+)?function\s+(?:parseBody|readResponseBody|parseSSEBlock|getSSEEventType)\b/,
        /\basync\s+function\*\s+parseResponsesSSEEvents\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates model metadata helpers to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:mapAnthropicModelsToOpenAI|mapOpenAIModelsToAnthropic|getAnthropicRequestHeaders)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates outbound chat request shaping to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:prepareRelayOutboundChatRequest|cloneJson)\b/,
        /\bcloneJson\s*\(/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates context compaction orchestration to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\b(?:async\s+)?function\s+(?:generateRelayContextSummary|compactRelayChatRequest|invokeWithRelayContextCompaction)\b/,
        /\b(?:compactChatRequestIfNeeded|isContextWindowExceededError)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Anthropic usage helpers to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:handleAnthropicUsageEvent|estimateAnthropicInputTokens)\b/,
        /from\s+['"][^'"]*utils\/token-estimation\.js['"]/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Anthropic stream bridge helpers to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\b(?:async\s+)?function\s+(?:writeAnthropicEvent|streamResponsesEventsAsAnthropic)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates response writing helpers to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:sendJson|sendOpenAIError|sendAnthropicError|sendStateMissingOpenAIError|toResponsesWebSocketStateMissingError|sendResponsesWebSocketProtocolError)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates OpenAI passthrough stream helper to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+_streamOpenAIPassthrough\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates metadata endpoints to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+(?:handleOpenAIModels|handleAnthropicModels|handleAnthropicCountTokens)\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Chat Completions handler to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+handleOpenAIChatCompletions\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Anthropic Messages handler to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+handleAnthropicMessages\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Responses API handler to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+handleResponsesAPI\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Responses Compact handler to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+handleResponsesCompact\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates Responses WebSocket handler to relay services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\*\s+_relayWSHandleRequest\b/,
        /\bexport\s+async\s+function\s+handleRelayResponsesWS\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay route delegates handler composition to relay runtime service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/relay.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /from\s+['"][^'"]*services\/providers\/index\.js['"]/,
        /from\s+['"][^'"]*services\/session\/index\.js['"]/,
        /from\s+['"][^'"]*services\/shared\/index\.js['"]/,
        /from\s+['"][^'"]*services\/relay\/(?:protocol-adapter|.*-handler|metadata-endpoints|context-compaction|usage|upstream-context|response-state|stream-events|model-metadata|anthropic-(?:adapter|usage|stream)|openai-stream|outbound-chat|conversation-key)\.js['"]/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('codebuddy route delegates support helpers to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:sendJson|sendOpenAIError|sendAnthropicError|upstreamErrorStatus)\b/,
        /\bfunction\s+(?:normalizeConversationId|extractConversationIdFromPayload|resolveConversationId)\b/,
        /\basync\s+function\s+(?:authenticateAndGetCredential|resolveTenantManager)\b/,
        /\bfunction\s+prepareCodebuddyOutboundChatRequest\b/,
        /from\s+['"][^'"]*utils\/http-client\.js['"]/,
        /from\s+['"][^'"]*services\/gateway\/gateway-auth\.js['"]/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('codebuddy route delegates Chat Completions handler to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleOpenAIChatCompletions\b/.test(source), false);
});

test('codebuddy route delegates Anthropic Messages handler to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleAnthropicMessages\b/.test(source), false);
});

test('codebuddy route delegates Responses Compact handler to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleResponsesCompact\b/.test(source), false);
});

test('codebuddy route delegates Responses API handler to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleResponsesAPI\b/.test(source), false);
});

test('codebuddy route delegates Responses WebSocket handler to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    assert.equal(/\bexport\s+function\s+handleCodebuddyResponsesWS\b/.test(source), false);
});

test('codebuddy route delegates metadata handlers to codebuddy services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    const forbiddenPatterns = [
        /\basync\s+function\s+handleOpenAIModels\b/,
        /\basync\s+function\s+handleAnthropicCountTokens\b/,
        /\basync\s+function\s+handleAnthropicModels\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => pattern.source);
    assert.deepEqual(violations, []);
});

test('codebuddy route delegates handler composition to codebuddy runtime service', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/codebuddy.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\basync\s+function\s+parseBody\b/,
        /\basync\s+function\s+handleCredentials\b/,
        /\bfunction\s+handleRoot\b/,
        /from\s+['"][^'"]*services\/providers\/index\.js['"]/,
        /from\s+['"][^'"]*services\/shared\/index\.js['"]/,
        /from\s+['"][^'"]*services\/codebuddy\/(?:api|anthropic-adapter|protocol-adapter|config|response-writer|conversation-key|outbound-chat|credential-context|usage|model-mapping|.*-handler|metadata-handler)\.js['"]/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('relay and codebuddy anthropic adapters delegate request conversion to core protocol', async () => {
    const checkedAdapters = [
        'src/services/relay/anthropic-adapter.js',
        'src/services/codebuddy/anthropic-adapter.js'
    ];
    const privateRequestHelpers = /\bfunction\s+(?:translateMessages|handleUserMessage|handleAssistantMessage|translateTools|resolveThinkingConfig)\b/;
    const violations = [];

    for (const adapter of checkedAdapters) {
        const source = await readFile(path.join(repoRoot, adapter), 'utf8');
        if (privateRequestHelpers.test(source)) {
            violations.push(adapter);
        }
    }

    assert.deepEqual(violations, []);
});

test('anthropic adapters do not re-export unrelated stream helpers', async () => {
    const checkedAdapters = [
        'src/services/relay/anthropic-adapter.js',
        'src/services/codebuddy/anthropic-adapter.js',
    ];
    const violations = [];

    for (const adapter of checkedAdapters) {
        const source = await readFile(path.join(repoRoot, adapter), 'utf8');
        if (/rewriteOpenAIStream/.test(source)) {
            violations.push(adapter);
        }
    }

    assert.deepEqual(violations, []);
});

test('product services centralize protocol core imports in protocol adapters', async () => {
    const productRoots = ['codebuddy', 'relay']
        .map((name) => path.join(servicesRoot, name));
    const files = (await Promise.all(productRoots.map(listJsFiles))).flat();
    const violations = [];

    for (const file of files) {
        if (path.basename(file) === 'protocol-adapter.js') continue;

        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*core\/protocol\/index\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

test('product protocol adapters import the protocol engine public module', async () => {
    const checkedAdapters = [
        'src/services/relay/protocol-adapter.js',
        'src/services/codebuddy/protocol-adapter.js',
        'src/services/shared/protocol-adapter.js',
        'src/services/providers/protocol-adapter.js',
        'src/services/session/protocol-adapter.js'
    ];
    const violations = [];

    for (const adapter of checkedAdapters) {
        const source = await readFile(path.join(repoRoot, adapter), 'utf8');
        const normalized = source.replaceAll('\\', '/');
        if (!/from\s+['"]#protocol-engine['"]/.test(normalized)) {
            violations.push(adapter);
        }
        if (/from\s+['"][^'"]*(?:core\/protocol|protocol-engine\/core|protocol-engine\/index)\.js['"]/.test(normalized)) {
            violations.push(`${adapter}:private-protocol-path`);
        }
    }

    assert.deepEqual(violations, []);
});

test('shared services centralize protocol core imports in their protocol adapter', async () => {
    const files = await listJsFiles(sharedServicesRoot);
    const violations = [];

    for (const file of files) {
        if (path.basename(file) === 'protocol-adapter.js') continue;

        const source = await readFile(file, 'utf8');
        if (/from\s+['"][^'"]*core\/protocol\/index\.js['"]/.test(source.replaceAll('\\', '/'))) {
            violations.push(path.relative(repoRoot, file).replaceAll('\\', '/'));
        }
    }

    assert.deepEqual(violations, []);
});

