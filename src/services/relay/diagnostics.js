function byteLength(value) {
    return Buffer.byteLength(String(value || ''), 'utf8');
}

function safeJsonByteLength(value) {
    try {
        return byteLength(JSON.stringify(value));
    } catch {
        return byteLength(String(value));
    }
}

function isValidJsonObjectText(value) {
    if (typeof value !== 'string') return false;
    try {
        JSON.parse(value || '{}');
        return true;
    } catch {
        return false;
    }
}

export function analyzeChatToolClosure(messages = []) {
    const toolCalls = [];
    const toolResults = [];

    if (!Array.isArray(messages)) {
        return {
            toolCallCount: 0,
            toolResultCount: 0,
            missingToolResults: [],
            orphanToolResults: [],
            duplicateToolResults: []
        };
    }

    messages.forEach((message, messageIndex) => {
        if (!message || typeof message !== 'object') return;

        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                if (!toolCall?.id) continue;
                toolCalls.push({
                    toolCallId: toolCall.id,
                    messageIndex,
                    name: toolCall.function?.name || ''
                });
            }
        }

        if (message.role === 'tool' && message.tool_call_id) {
            toolResults.push({
                toolCallId: message.tool_call_id,
                messageIndex
            });
        }
    });

    const resultIds = new Set(toolResults.map((item) => item.toolCallId));
    const callIds = new Set(toolCalls.map((item) => item.toolCallId));
    const resultCounts = new Map();
    for (const result of toolResults) {
        resultCounts.set(result.toolCallId, (resultCounts.get(result.toolCallId) || 0) + 1);
    }

    return {
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        missingToolResults: toolCalls
            .filter((item) => !resultIds.has(item.toolCallId))
            .map((item) => ({
                toolCallId: item.toolCallId,
                messageIndex: item.messageIndex,
                name: item.name
            })),
        orphanToolResults: toolResults
            .filter((item) => !callIds.has(item.toolCallId))
            .map((item) => ({
                toolCallId: item.toolCallId,
                messageIndex: item.messageIndex
            })),
        duplicateToolResults: [...resultCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([toolCallId, count]) => ({toolCallId, count}))
    };
}

export function analyzeCanonicalToolClosure(session = {}) {
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    const mappings = new Map(
        (Array.isArray(session?.toolMappings) ? session.toolMappings : [])
            .filter((mapping) => mapping?.canonicalToolCallId)
            .map((mapping) => [mapping.canonicalToolCallId, mapping])
    );
    const toolCalls = [];
    const toolResults = [];

    turns.forEach((turn, turnIndex) => {
        const blocks = Array.isArray(turn?.blocks) ? turn.blocks : [];
        blocks.forEach((block, blockIndex) => {
            if (!block || typeof block !== 'object') return;
            if (block.type === 'tool_call' && block.canonicalToolCallId) {
                toolCalls.push({
                    canonicalToolCallId: block.canonicalToolCallId,
                    turnIndex,
                    blockIndex,
                    name: block.name || mappings.get(block.canonicalToolCallId)?.name || '',
                    toolIds: protocolToolIds(mappings.get(block.canonicalToolCallId))
                });
            }
            if (block.type === 'tool_result' && block.canonicalToolCallId) {
                toolResults.push({
                    canonicalToolCallId: block.canonicalToolCallId,
                    turnIndex,
                    blockIndex,
                    toolIds: protocolToolIds(mappings.get(block.canonicalToolCallId))
                });
            }
        });
    });

    const resultIds = new Set(toolResults.map((item) => item.canonicalToolCallId));
    const callIds = new Set(toolCalls.map((item) => item.canonicalToolCallId));
    const resultCounts = new Map();
    for (const result of toolResults) {
        resultCounts.set(result.canonicalToolCallId, (resultCounts.get(result.canonicalToolCallId) || 0) + 1);
    }

    return {
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
        missingToolResults: toolCalls.filter((item) => !resultIds.has(item.canonicalToolCallId)),
        orphanToolResults: toolResults.filter((item) => !callIds.has(item.canonicalToolCallId)),
        duplicateToolResults: [...resultCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([canonicalToolCallId, count]) => ({canonicalToolCallId, count}))
    };
}

function protocolToolIds(mapping = {}) {
    return {
        openAIChatToolCallId: mapping?.openAIChatToolCallId || null,
        responsesCallId: mapping?.responsesCallId || null,
        responsesItemId: mapping?.responsesItemId || null,
        anthropicToolUseId: mapping?.anthropicToolUseId || null
    };
}

export function getRelayConversationDiagnostics(store, options = {}) {
    const tenantId = options?.tenantId || null;
    const conversations = store?.conversations instanceof Map ? store.conversations : new Map();
    const responseIndex = store?.responseIndex instanceof Map ? store.responseIndex : new Map();
    const sessions = [];

    for (const [conversationId, state] of conversations.entries()) {
        if (tenantId && state?.tenantId !== tenantId) continue;
        const chatRequest = state?.chatRequest || {};
        const messages = Array.isArray(chatRequest.messages) ? chatRequest.messages : [];
        const toolClosure = analyzeChatToolClosure(messages);
        const canonical = summarizeCanonicalSession(state?.canonicalSession);
        const canonicalToolClosure = analyzeCanonicalToolClosure(state?.canonicalSession);
        const approxBytes = safeJsonByteLength(chatRequest);
        const canonicalApproxBytes = safeJsonByteLength(state?.canonicalSession);
        sessions.push({
            conversationId,
            tenantId: state?.tenantId || null,
            conversationKey: state?.conversationKey || null,
            updatedAt: state?.updatedAt || 0,
            turnCount: messages.filter((message) => message?.role === 'user').length,
            messageCount: messages.length,
            chatRequestTruncated: state?.chatRequestTruncated === true,
            chatRequestMessageCount: state?.chatRequestMessageCount || messages.length,
            streamBufferBytes: 0,
            toolDefinitionCount: Array.isArray(chatRequest.tools) ? chatRequest.tools.length : 0,
            toolCallCount: toolClosure.toolCallCount,
            toolResultCount: toolClosure.toolResultCount,
            canonicalTurnCount: canonical.turnCount,
            canonicalSessionTruncated: state?.canonicalSessionTruncated === true,
            canonicalOriginalTurnCount: state?.canonicalTurnCount || canonical.turnCount,
            canonicalBlockCount: canonical.blockCount,
            canonicalToolMappingCount: canonical.toolMappingCount,
            canonicalToolCallCount: canonical.toolCallCount,
            canonicalToolResultCount: canonical.toolResultCount,
            canonicalApproxBytes,
            responseCount: state?.responses instanceof Set ? state.responses.size : 0,
            lastResponseId: state?.lastResponseId || null,
            approxBytes,
            combinedApproxBytes: approxBytes + canonicalApproxBytes,
            missingToolResults: toolClosure.missingToolResults,
            orphanToolResults: toolClosure.orphanToolResults,
            duplicateToolResults: toolClosure.duplicateToolResults,
            canonicalMissingToolResults: canonicalToolClosure.missingToolResults,
            canonicalOrphanToolResults: canonicalToolClosure.orphanToolResults,
            canonicalDuplicateToolResults: canonicalToolClosure.duplicateToolResults
        });
    }

    sessions.sort((left, right) => right.combinedApproxBytes - left.combinedApproxBytes);

    return {
        totalConversations: sessions.length,
        storedConversations: conversations.size,
        totalResponseIndexEntries: countResponseIndexEntries(responseIndex, tenantId),
        totalApproxBytes: sessions.reduce((sum, session) => sum + session.approxBytes, 0),
        totalCanonicalApproxBytes: sessions.reduce((sum, session) => sum + session.canonicalApproxBytes, 0),
        totalCombinedApproxBytes: sessions.reduce((sum, session) => sum + session.combinedApproxBytes, 0),
        memoryHotspots: sessions.slice(0, 10).map((session) => ({
            conversationId: session.conversationId,
            messageCount: session.messageCount,
            chatRequestTruncated: session.chatRequestTruncated,
            chatRequestMessageCount: session.chatRequestMessageCount,
            canonicalTurnCount: session.canonicalTurnCount,
            canonicalSessionTruncated: session.canonicalSessionTruncated,
            canonicalOriginalTurnCount: session.canonicalOriginalTurnCount,
            approxBytes: session.approxBytes,
            canonicalApproxBytes: session.canonicalApproxBytes,
            combinedApproxBytes: session.combinedApproxBytes,
            streamBufferBytes: session.streamBufferBytes,
            toolCallCount: session.toolCallCount,
            toolResultCount: session.toolResultCount
        })),
        toolIssues: sessions.flatMap((session) => [
            ...session.missingToolResults.map((issue) => ({
                type: 'missing_tool_result',
                conversationId: session.conversationId,
                ...issue
            })),
            ...session.orphanToolResults.map((issue) => ({
                type: 'orphan_tool_result',
                conversationId: session.conversationId,
                ...issue
            })),
            ...session.duplicateToolResults.map((issue) => ({
                type: 'duplicate_tool_result',
                conversationId: session.conversationId,
                ...issue
            })),
            ...session.canonicalMissingToolResults.map((issue) => ({
                type: 'missing_canonical_tool_result',
                conversationId: session.conversationId,
                ...issue
            })),
            ...session.canonicalOrphanToolResults.map((issue) => ({
                type: 'orphan_canonical_tool_result',
                conversationId: session.conversationId,
                ...issue
            })),
            ...session.canonicalDuplicateToolResults.map((issue) => ({
                type: 'duplicate_canonical_tool_result',
                conversationId: session.conversationId,
                ...issue
            }))
        ]),
        sessions
    };
}

function summarizeCanonicalSession(session = {}) {
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    const blocks = turns.flatMap((turn) => Array.isArray(turn?.blocks) ? turn.blocks : []);
    return {
        turnCount: turns.length,
        blockCount: blocks.length,
        toolMappingCount: Array.isArray(session?.toolMappings) ? session.toolMappings.length : 0,
        toolCallCount: blocks.filter((block) => block?.type === 'tool_call').length,
        toolResultCount: blocks.filter((block) => block?.type === 'tool_result').length
    };
}

function countResponseIndexEntries(responseIndex, tenantId) {
    if (!tenantId) return responseIndex.size;
    let count = 0;
    const prefix = `${tenantId}:`;
    for (const key of responseIndex.keys()) {
        if (String(key).startsWith(prefix)) count++;
    }
    return count;
}

export function inspectResponsesStreamState(state = {}) {
    const toolCallArgs = state.toolCallArgs instanceof Map ? state.toolCallArgs : new Map();
    const toolCallItemIds = state.toolCallItemIds instanceof Map ? state.toolCallItemIds : new Map();
    const toolCallNames = state.toolCallNames instanceof Map ? state.toolCallNames : new Map();
    const partialToolArguments = [];

    for (const [index, args] of toolCallArgs.entries()) {
        const text = String(args || '');
        const validJson = isValidJsonObjectText(text);
        if (validJson) continue;
        partialToolArguments.push({
            index,
            itemId: toolCallItemIds.get(index) || null,
            name: toolCallNames.get(index) || '',
            bytes: byteLength(text),
            validJson
        });
    }

    return {
        unclosedMessage: state.messageOpen === true,
        unclosedReasoning: state.reasoningOpen === true,
        textBufferBytes: byteLength(state.textBuffer),
        reasoningBufferBytes: byteLength(state.reasoningText),
        toolArgumentsBytes: [...toolCallArgs.values()].reduce((sum, value) => sum + byteLength(value), 0),
        outputItemCount: Array.isArray(state.output) ? state.output.length : 0,
        partialToolArguments
    };
}
