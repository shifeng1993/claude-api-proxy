import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCodebuddyConversationId} from '../src/services/codebuddy/conversation-key.js';
import {prepareCodebuddyOutboundChatRequest} from '../src/services/codebuddy/protocols/chat/outbound.js';
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

    const overloadedRes = createResponse();
    sendCodebuddyAnthropicError(overloadedRes, 503, 'Busy');
    assert.equal(overloadedRes.status, 503);
    assert.deepEqual(JSON.parse(overloadedRes.body), {
        type: 'error',
        error: {type: 'overloaded_error', message: 'Busy'}
    });

    const jsonRes = createResponse();
    sendCodebuddyJsonResponse(jsonRes, 200, {ok: true});
    assert.deepEqual(JSON.parse(jsonRes.body), {ok: true});
});

test('CodeBuddy upstream error status maps network errors to 502', () => {
    assert.equal(codebuddyUpstreamErrorStatus(Object.assign(new Error('invalid json'), {status: 502})), 502);
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

test('prepareCodebuddyOutboundChatRequest strips Codex-only parameters before upstream', () => {
    const request = {
        model: 'client-model',
        messages: [
            {role: 'developer', content: 'developer instructions'},
            {role: 'user', content: 'hello'}
        ],
        max_completion_tokens: 256,
        reasoning: {effort: 'medium'},
        previous_response_id: 'resp_1',
        store: false,
        metadata: {threadId: 'thread-1'},
        service_tier: 'auto',
        parallel_tool_calls: true,
        response_format: {type: 'json_object'},
        user: 'codex-user',
        tools: [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read a file',
                    parameters: {type: 'object'},
                    strict: true
                }
            },
            {type: 'web_search_preview'}
        ],
        tool_choice: 'auto'
    };

    const result = prepareCodebuddyOutboundChatRequest(request);

    assert.equal(result.max_tokens, 256);
    assert.equal(result.reasoning_effort, 'medium');
    assert.equal(result.messages[0].role, 'system');
    assert.deepEqual(result.tools, [{
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {type: 'object'}
        }
    }]);
    for (const field of [
        'max_completion_tokens',
        'reasoning',
        'previous_response_id',
        'store',
        'metadata',
        'service_tier',
        'parallel_tool_calls',
        'response_format',
        'user'
    ]) {
        assert.equal(field in result, false, `${field} should not be sent to CodeBuddy upstream`);
    }
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
