import test from 'node:test';
import assert from 'node:assert/strict';
import {
    copilotUpstreamErrorStatus,
    isCopilotResponsesProtocolError,
    sendCopilotAnthropicError,
    sendCopilotJsonResponse,
    sendCopilotOpenAIError,
    sendCopilotResponsesProtocolError
} from '../src/services/copilot/response-writer.js';
import {
    extractCopilotConversationKey,
    extractCopilotConversationKeyFromPayload
} from '../src/services/copilot/conversation-key.js';
import {
    createCopilotNetworkOptionsResolver,
    extractCopilotProxyFromHeaders
} from '../src/services/copilot/network-options.js';
import {createCopilotAuthResolver} from '../src/services/copilot/auth-context.js';
import {
    ensureCopilotResponsesWebSocketSupported,
    supportsCopilotResponsesWebSocket
} from '../src/services/copilot/model-support.js';
import {ResponsesWebSocketError} from '../src/services/shared/index.js';

function createResponse(headersSent = false) {
    return {
        headersSent,
        destroyed: false,
        writableEnded: false,
        calls: [],
        writeHead(status, headers) {
            this.headersSent = true;
            this.calls.push(['writeHead', status, headers]);
        },
        write(chunk) {
            this.calls.push(['write', chunk]);
        },
        end(chunk) {
            this.writableEnded = true;
            this.calls.push(['end', chunk]);
        }
    };
}

test('Copilot response writer emits OpenAI and Anthropic error shapes', () => {
    const openAIRes = createResponse();
    sendCopilotOpenAIError(openAIRes, 401, 'nope', 'authentication_error');
    assert.deepEqual(openAIRes.calls[1], ['end', JSON.stringify({
        error: {message: 'nope', type: 'authentication_error', code: 401}
    })]);

    const anthropicRes = createResponse();
    sendCopilotAnthropicError(anthropicRes, 503, 'busy');
    assert.deepEqual(anthropicRes.calls[1], ['end', JSON.stringify({
        type: 'error',
        error: {type: 'overloaded_error', message: 'busy'}
    })]);
});

test('Copilot response writer streams protocol errors after headers are sent', () => {
    const res = createResponse(true);
    const error = new ResponsesWebSocketError({
        type: 'error',
        status: 400,
        error: {message: 'bad request', code: 'bad_request'}
    });

    assert.equal(isCopilotResponsesProtocolError(error), true);
    sendCopilotResponsesProtocolError(res, error);

    assert.equal(res.calls[0][0], 'write');
    assert.match(res.calls[0][1], /event: error/);
    assert.equal(res.calls[1][0], 'end');
});

test('Copilot upstream error status maps network errors to 502', () => {
    assert.equal(copilotUpstreamErrorStatus({code: 'ECONNRESET'}), 502);
    assert.equal(copilotUpstreamErrorStatus(new Error('plain')), 500);
});

test('Copilot conversation key prefers headers before payload metadata', () => {
    const req = {
        headers: {
            'x-session-id': ['header-session']
        }
    };
    const payload = {metadata: {threadId: 'payload-thread'}};

    assert.equal(extractCopilotConversationKey(req, payload), 'header-session');
    assert.equal(extractCopilotConversationKeyFromPayload(payload), 'payload-thread');
});

test('Copilot network options use stored proxy before local compatibility header', () => {
    const store = {
        getProxyUrl: () => 'http://stored-proxy.test',
        getRejectUnauthorized: () => false
    };
    const resolveNetworkOptions = createCopilotNetworkOptionsResolver({store});

    const options = resolveNetworkOptions({
        headers: {'x-copilot-proxy': 'http://header-proxy.test'},
        socket: {remoteAddress: '127.0.0.1'}
    });

    assert.deepEqual(options, {
        proxyUrl: 'http://stored-proxy.test',
        rejectUnauthorized: false
    });
});

test('Copilot proxy compatibility header is local-only', () => {
    const store = {
        getProxyUrl: () => '',
        getRejectUnauthorized: () => true
    };

    assert.equal(extractCopilotProxyFromHeaders({
        headers: {'x-copilot-proxy': 'http://local-proxy.test'},
        socket: {remoteAddress: '::1'}
    }, store), 'http://local-proxy.test');
    assert.equal(extractCopilotProxyFromHeaders({
        headers: {'x-copilot-proxy': 'http://remote-proxy.test'},
        socket: {remoteAddress: '10.0.0.2'}
    }, store), undefined);
});

test('Copilot auth resolver maps unauthenticated and token failures', async () => {
    const unauthenticated = createCopilotAuthResolver({
        isAuthenticated: () => false,
        ensureCopilotToken: async () => 'unused',
        store: {getProxyUrl: () => ''}
    });
    assert.deepEqual(await unauthenticated(), {
        error: {
            status: 401,
            message: 'Not authenticated. Open the Copilot tab in /dashboard to connect GitHub.'
        }
    });

    const tokenFailure = createCopilotAuthResolver({
        isAuthenticated: () => true,
        ensureCopilotToken: async () => {
            throw new Error('token failed');
        },
        store: {getProxyUrl: () => ''}
    });
    assert.deepEqual(await tokenFailure(), {
        error: {status: 503, message: 'token failed'}
    });
});

test('Copilot Responses WebSocket support is GPT-series only', () => {
    assert.equal(supportsCopilotResponsesWebSocket('gpt-5.1'), true);
    assert.equal(supportsCopilotResponsesWebSocket('claude-sonnet-4'), false);
    assert.throws(
        () => ensureCopilotResponsesWebSocketSupported('claude-sonnet-4'),
        /GPT-series/
    );
});
