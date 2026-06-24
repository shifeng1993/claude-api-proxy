import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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

test('product services name protocol shims as adapters instead of translators', async () => {
    const files = await listJsFiles(servicesRoot);
    const forbiddenFiles = files
        .map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
        .filter((file) => /(?:^|\/)(?:.*-)?translator\.js$/.test(path.basename(file)));

    assert.deepEqual(forbiddenFiles, []);
});

test('routes do not depend on another product service API for shared helpers', async () => {
    const checkedRoutes = [
        'src/routes/relay.js',
        'src/routes/copilot.js'
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
        'src/routes/copilot.js',
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

test('copilot route delegates support helpers to copilot services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/copilot.js'), 'utf8');
    const normalized = source.replaceAll('\\', '/');
    const forbiddenPatterns = [
        /\bfunction\s+(?:sendJson|sendOpenAIError|sendAnthropicError|isResponsesProtocolError|sendResponsesProtocolError|upstreamErrorStatus)\b/,
        /\bfunction\s+(?:extractProxyFromHeaders|getCopilotNetworkOptions|normalizeConversationKey|extractConversationKeyFromPayload|extractConversationKey)\b/,
        /\basync\s+function\s+ensureCopilotAuth\b/,
        /\bResponsesWebSocketError\b/,
        /\bisNetworkError\b/
    ];
    const violations = forbiddenPatterns
        .filter((pattern) => pattern.test(normalized))
        .map((pattern) => pattern.source);

    assert.deepEqual(violations, []);
});

test('copilot route delegates metadata handlers to copilot services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/copilot.js'), 'utf8');
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

test('copilot route delegates Chat Completions handler to copilot services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/copilot.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleOpenAIChatCompletions\b/.test(source), false);
});

test('copilot route delegates Responses Compact handler to copilot services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/copilot.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleResponsesCompact\b/.test(source), false);
});

test('copilot route delegates Anthropic Messages handler to copilot services', async () => {
    const source = await readFile(path.join(repoRoot, 'src/routes/copilot.js'), 'utf8');
    assert.equal(/\basync\s+function\s+handleAnthropicMessages\b/.test(source), false);
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
        'src/services/copilot/anthropic-adapter.js'
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
    const productRoots = ['codebuddy', 'copilot', 'relay']
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

test('copilot anthropic adapter delegates Responses conversions to core protocol', async () => {
    const source = await readFile(path.join(repoRoot, 'src/services/copilot/anthropic-adapter.js'), 'utf8');
    const privateResponsesHelpers = /\bfunction\s+(?:anthropicContentToResponsesContent|anthropicMessagesToResponsesInput|anthropicSystemToInstructions|anthropicToolChoiceToResponses)\b/;

    assert.equal(privateResponsesHelpers.test(source), false);
});

test('copilot anthropic adapter delegates Chat request conversion to core protocol', async () => {
    const source = await readFile(path.join(repoRoot, 'src/services/copilot/anthropic-adapter.js'), 'utf8');
    const privateChatHelpers = /\bfunction\s+(?:resolveThinkingConfig|translateMessages|handleUserMessage|handleAssistantMessage)\b/;

    assert.equal(privateChatHelpers.test(source), false);
});
