import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCodebuddyConversationId} from '../src/services/codebuddy/conversation-key.js';
import {prepareCodebuddyOutboundChatRequest} from '../src/services/codebuddy/outbound-chat.js';
import {
    createCodebuddyCredentialResolver,
    createCodebuddyTenantCredentialManagerResolver
} from '../src/services/codebuddy/credential-context.js';
import {
    createCodebuddyUsageRecorder,
    pickCodebuddyUsageModel
} from '../src/services/codebuddy/usage.js';
import {
    codebuddyUpstreamErrorStatus,
    sendCodebuddyAnthropicError,
    sendCodebuddyJsonResponse,
    sendCodebuddyOpenAIError
} from '../src/services/codebuddy/response-writer.js';

function createResponse() {
    return {
        headersSent: false,
        writes: [],
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
        end(body) {
            this.body = body;
        }
    };
}

test('CodeBuddy response writer emits OpenAI and Anthropic error shapes', () => {
    const openAIRes = createResponse();
    sendCodebuddyOpenAIError(openAIRes, 401, 'No token', 'authentication_error');
    assert.equal(openAIRes.status, 401);
    assert.deepEqual(JSON.parse(openAIRes.body), {
        error: {message: 'No token', type: 'authentication_error', code: 401}
    });

    const anthropicRes = createResponse();
    sendCodebuddyAnthropicError(anthropicRes, 500, 'Upstream failed');
    assert.equal(anthropicRes.status, 500);
    assert.deepEqual(JSON.parse(anthropicRes.body), {
        type: 'error',
        error: {type: 'api_error', message: 'Upstream failed'}
    });

    const jsonRes = createResponse();
    sendCodebuddyJsonResponse(jsonRes, 200, {ok: true});
    assert.deepEqual(JSON.parse(jsonRes.body), {ok: true});
});

test('CodeBuddy upstream error status maps network errors to 502', () => {
    assert.equal(codebuddyUpstreamErrorStatus({code: 'ECONNRESET'}), 502);
    assert.equal(codebuddyUpstreamErrorStatus(new Error('plain')), 500);
});

test('CodeBuddy conversation id prefers headers and payload ids before anchor fallback', () => {
    assert.equal(
        resolveCodebuddyConversationId(
            {headers: {'x-session-id': ' session-1 '}},
            [{role: 'user', content: 'hello'}],
            {},
            {tenantId: 42}
        ),
        'session-1'
    );

    assert.equal(
        resolveCodebuddyConversationId(
            {headers: {}},
            [{role: 'user', content: 'hello'}],
            {metadata: {threadId: 'thread-1'}},
            {tenantId: 42}
        ),
        'thread-1'
    );
});

test('prepareCodebuddyOutboundChatRequest maps model, stream, rules, and message ordering', () => {
    const request = {
        model: 'client-model',
        messages: [
            {role: 'assistant', tool_calls: [{id: 'call_1', type: 'function', function: {name: 'tool', arguments: '{}'}}]},
            {role: 'tool', tool_call_id: 'call_1', content: 'done'}
        ]
    };

    const result = prepareCodebuddyOutboundChatRequest(request, {model: 'upstream-model', stream: true});

    assert.equal(result, request);
    assert.equal(result.model, 'upstream-model');
    assert.equal(result.stream, true);
    assert.equal(Array.isArray(result.messages), true);
});

test('CodeBuddy credential resolvers use tenant-scoped credentials and managers', async () => {
    const credentialService = {
        listCredentials: async (tenantId) => ({
            credentials: [{id: 'inactive'}, {id: `active-${tenantId}`}],
            activeIndex: 1
        }),
        getCredentialManager: async (tenantId) => ({tenantId})
    };
    const resolveCredential = (headers, credentials, activeIndex) => credentials[activeIndex];
    const resolveCredentialContext = createCodebuddyCredentialResolver({credentialService, resolveCredential});
    const resolveManager = createCodebuddyTenantCredentialManagerResolver({credentialService});

    assert.deepEqual(await resolveCredentialContext({tenantId: 42, headers: {}}), {
        credential: {id: 'active-42'},
        tenantId: 42
    });
    assert.deepEqual(await resolveManager({tenantId: 42}), {manager: {tenantId: 42}, tenantId: 42});
});

test('CodeBuddy usage recorder writes all usage dimensions to the tenant manager', () => {
    const calls = [];
    const tenantManager = {
        incrementApiCallCount: (...args) => calls.push(['api', args]),
        incrementTokenUsage: (...args) => calls.push(['tokens', args]),
        incrementCreditUsage: (...args) => calls.push(['credit', args]),
        recordDailyUsage: (...args) => calls.push(['daily', args])
    };
    const {recordUsage} = createCodebuddyUsageRecorder(tenantManager);

    recordUsage(42, 1, 2, 3, 4, 'ep-hidden', 'client-model');

    assert.equal(pickCodebuddyUsageModel('ep-hidden', 'client-model'), 'client-model');
    assert.deepEqual(calls, [
        ['api', [42, 'codebuddy']],
        ['tokens', [42, 'codebuddy', 1, 2, 3]],
        ['credit', [42, 'codebuddy', 4]],
        ['daily', [42, 'codebuddy', 1, 2, 3, 4, 'client-model']]
    ]);
});
