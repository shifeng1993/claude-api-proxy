import {
    limitResponsesInputItems,
    resolveResponsesInputItemsLimit
} from './protocol-adapter.js';
import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';

const DEFAULT_DIAGNOSTIC_FILE = path.join('logs', 'responses-continuation-diagnostics.jsonl');
const RESPONSES_PROVIDER_INPUT_ITEMS_LIMIT = 1000;

export function prepareResponsesContinuationPayload({
    conversationStore,
    tenantId,
    conversationKey,
    request,
    requestType,
    disableContinuation = false,
    logger: log = logger
} = {}) {
    const prepared = conversationStore.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request
    });
    const stateConversationKey = prepared.conversationKey || conversationKey;
    if (disableContinuation === true) {
        const fullRequest = stripResponsesContinuationFields(prepared.request);
        const inputLength = countResponsesInputItems(fullRequest?.input);
        const limited = {
            payload: fullRequest,
            input: fullRequest?.input,
            truncated: false,
            originalLength: inputLength,
            retainedLength: inputLength,
            droppedCount: 0,
            previousResponseId: null
        };
        log.info(
            `Responses continuation: disabled; sending full input items=${inputLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
        );
        const delta = {
            request: fullRequest,
            deltaAttempted: false,
            deltaApplied: false,
            emptyDelta: false,
            candidates: [],
            originalLength: inputLength,
            retainedLength: inputLength,
            coveredLength: 0,
            previousResponseId: null
        };
        writeContinuationDiagnostic({
            tenantId,
            conversationKey: stateConversationKey,
            requestType,
            sourceRequest: prepared.request,
            outboundRequest: limited.payload,
            delta,
            limited,
            logger: log
        });
        return {
            request: fullRequest,
            conversationKey: stateConversationKey,
            lastResponseId: prepared.lastResponseId,
            autoLink: false,
            skipInputItemLimit: true,
            deltaApplied: false,
            deltaAttempted: false,
            emptyDelta: false,
            deltaPreviousResponseId: null,
            deltaCoveredLength: 0,
            truncated: limited.truncated,
            originalLength: limited.originalLength,
            retainedLength: limited.retainedLength,
            droppedCount: limited.droppedCount
        };
    }
    const continuation = createDirectContinuationRequest(prepared.request, prepared);
    const chainReset = getDirectContinuationChainReset(continuation);
    const outboundRequest = chainReset
        ? stripResponsesContinuationFields(prepared.request)
        : continuation.request;
    const previousResponseId = !chainReset && continuation.applied
        ? continuation.previousResponseId
        : null;
    const limited = limitResponsesInputItems(outboundRequest, {previousResponseId});
    const outboundDeltaApplied = continuation.applied && !chainReset;
    const diagnosticDelta = {
        request: continuation.request,
        deltaAttempted: continuation.attempted,
        deltaApplied: outboundDeltaApplied,
        emptyDelta: continuation.emptyDelta,
        candidates: [],
        originalLength: continuation.originalLength,
        retainedLength: continuation.retainedLength,
        coveredLength: continuation.droppedCount,
        previousInputLength: continuation.previousInputLength,
        previousResponseId: continuation.previousResponseId,
        directContinuation: continuation.applied === true,
        ...(chainReset
        ? {
            chainReset: true,
            chainInputLength: chainReset.chainInputLength,
            chainLimit: chainReset.limit
        }
        : {})
    };

    if (limited.truncated) {
        log.info(
            `Responses continuation: truncated input items ${limited.originalLength}->${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${limited.previousResponseId}`
        );
    }
    if (chainReset) {
        log.info(
            `Responses continuation: provider chain input items `
            + `${chainReset.previousInputLength}+${chainReset.deltaInputLength}=${chainReset.chainInputLength}`
            + ` exceeds limit ${chainReset.limit}; resetting previous_response_id`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${continuation.previousResponseId}`
        );
        log.info(
            `Responses continuation: upstream input items=${countResponsesInputItems(limited.payload?.input)}`
            + ` source_input_items=${countResponsesInputItems(prepared.request?.input)}`
            + ` retained_input_items=${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=none`
            + ` autoLink=false chainReset=true`
        );
    } else if (continuation.applied) {
        log.info(
            `Responses continuation: delta input items ${continuation.originalLength}->${continuation.retainedLength}`
            + ` using previous_response_id`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${continuation.previousResponseId}`
        );
        log.info(
            `Responses continuation: upstream input items=${countResponsesInputItems(limited.payload?.input)}`
            + ` source_input_items=${countResponsesInputItems(prepared.request?.input)}`
            + ` retained_input_items=${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${normalizeResponseId(limited.payload?.previous_response_id) || 'none'}`
            + ` autoLink=true`
        );
    } else if (continuation.emptyDelta) {
        log.info(
            `Responses continuation: delta input empty; websocket auto-link disabled`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${continuation.previousResponseId || prepared.lastResponseId}`
        );
    }
    const autoLink = !chainReset && continuation.applied;

    writeContinuationDiagnostic({
        tenantId,
        conversationKey: stateConversationKey,
        requestType,
        sourceRequest: prepared.request,
        outboundRequest: limited.payload,
        delta: diagnosticDelta,
        limited,
        logger: log
    });

    return {
        request: limited.payload,
        conversationKey: stateConversationKey,
        lastResponseId: prepared.lastResponseId,
        autoLink,
        skipInputItemLimit: false,
        deltaApplied: outboundDeltaApplied,
        deltaAttempted: continuation.attempted,
        emptyDelta: continuation.emptyDelta === true,
        deltaPreviousResponseId: continuation.previousResponseId || null,
        deltaCoveredLength: continuation.droppedCount,
        chainReset: Boolean(chainReset),
        chainInputLength: chainReset?.chainInputLength || null,
        chainLimit: chainReset?.limit || null,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        retainedLength: limited.retainedLength,
        droppedCount: limited.droppedCount
    };
}

function createDirectContinuationRequest(request, prepared) {
    const previousResponseId = normalizeResponseId(request?.previous_response_id)
        || normalizeResponseId(prepared?.lastResponseId);
    const originalLength = countResponsesInputItems(request?.input);

    if (!previousResponseId) {
        return {
            request,
            attempted: false,
            applied: false,
            emptyDelta: false,
            originalLength,
            retainedLength: originalLength,
            droppedCount: 0,
            previousInputLength: 0,
            previousResponseId: null
        };
    }

    const input = extractDirectContinuationInput(request?.input);
    const retainedLength = countResponsesInputItems(input);
    const emptyDelta = Array.isArray(input) && input.length === 0;
    if (emptyDelta) {
        return {
            request: stripResponsesContinuationFields(request),
            attempted: true,
            applied: false,
            emptyDelta: true,
            originalLength,
            retainedLength,
            droppedCount: originalLength,
            previousInputLength: resolvePreviousInputLength(prepared, previousResponseId),
            previousResponseId
        };
    }

    return {
        request: {
            ...request,
            input,
            previous_response_id: previousResponseId
        },
        attempted: true,
        applied: true,
        emptyDelta: false,
        originalLength,
        retainedLength,
        droppedCount: Math.max(originalLength - retainedLength, 0),
        previousInputLength: Math.max(
            resolvePreviousInputLength(prepared, previousResponseId),
            Math.max(originalLength - retainedLength, 0)
        ),
        previousResponseId
    };
}

function extractDirectContinuationInput(input) {
    if (!Array.isArray(input)) return input;
    if (input.length <= 0) return input;

    const freshStart = findDirectContinuationFreshStart(input);
    if (freshStart === null) return [];
    return freshStart > 0 ? input.slice(freshStart) : input;
}

function findDirectContinuationFreshStart(input) {
    let sawOutputBoundary = false;
    const endsWithCoveredOutput = isCoveredContinuationOutputItem(input.at(-1));
    for (let index = input.length - 1; index >= 0; index--) {
        if (!isCoveredContinuationOutputItem(input[index])) continue;
        sawOutputBoundary = true;
        const suffix = input.slice(index + 1);
        if (
            suffix.some(isFreshContinuationInputItem)
            && (!endsWithCoveredOutput || suffix.some(isToolContinuationResultItem))
        ) {
            return index + 1;
        }
    }
    if (!sawOutputBoundary && input.length > 1 && input.at(-1)?.role === 'user') {
        return input.length - 1;
    }
    return sawOutputBoundary ? null : 0;
}

function resolvePreviousInputLength(prepared, previousResponseId) {
    const normalizedPreviousResponseId = normalizeResponseId(previousResponseId);
    if (!normalizedPreviousResponseId) return 0;

    if (
        normalizeResponseId(prepared?.lastResponseId) === normalizedPreviousResponseId
        && Array.isArray(prepared?.lastResponseInput)
    ) {
        return prepared.lastResponseInput.length;
    }

    const snapshot = (prepared?.responseInputSnapshots || []).find((item) =>
        normalizeResponseId(item?.responseId) === normalizedPreviousResponseId
    );
    return Array.isArray(snapshot?.input) ? snapshot.input.length : 0;
}

function getDirectContinuationChainReset(continuation) {
    if (!continuation?.applied) return null;
    const previousInputLength = Number.isFinite(continuation.previousInputLength)
        ? continuation.previousInputLength
        : 0;
    const sourceDeltaInputLength = Number.isFinite(continuation.retainedLength)
        ? continuation.retainedLength
        : countResponsesInputItems(continuation.request?.input);
    const deltaInputLength = Math.min(sourceDeltaInputLength, resolveResponsesInputItemsLimit());
    const chainInputLength = previousInputLength + deltaInputLength;
    const limit = RESPONSES_PROVIDER_INPUT_ITEMS_LIMIT;
    if (chainInputLength <= limit) return null;
    return {
        previousInputLength,
        deltaInputLength,
        chainInputLength,
        limit
    };
}

function isCoveredContinuationOutputItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.role === 'assistant') return item.partial !== true;
    return item.type === 'reasoning' || item.type === 'function_call' || item.type === 'output_text';
}

function isFreshContinuationInputItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.role === 'user' || item.role === 'tool') return true;
    if (item.role === 'assistant' && item.partial === true) return true;
    return item.type === 'function_call_output' || item.type === 'input_text';
}

function isToolContinuationResultItem(item) {
    if (!item || typeof item !== 'object') return false;
    return item.role === 'tool' || item.type === 'function_call_output';
}

function normalizeResponseId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripResponsesContinuationFields(request) {
    if (!request || typeof request !== 'object') return request;
    const next = {...request};
    delete next.previous_response_id;
    return next;
}

function countResponsesInputItems(input) {
    if (Array.isArray(input)) return input.length;
    return input == null ? 0 : 1;
}

function writeContinuationDiagnostic({
    tenantId,
    conversationKey,
    requestType,
    sourceRequest,
    outboundRequest,
    delta,
    limited,
    logger: log
}) {
    if (!isDiagnosticEnabled()) return;
    if (!delta?.deltaAttempted && !limited?.truncated) return;

    const filePath = resolveDiagnosticFilePath();
    const full = isFullDiagnosticEnabled();
    const record = {
        timestamp: new Date().toISOString(),
        event: 'responses_continuation',
        decision: getDiagnosticDecision(delta),
        tenantId: tenantId || null,
        conversationKey: conversationKey || null,
        requestType: requestType || null,
        model: sourceRequest?.model || null,
        previousResponseId: delta?.previousResponseId || null,
        delta: {
            attempted: delta?.deltaAttempted === true,
            applied: delta?.deltaApplied === true,
            empty: delta?.emptyDelta === true,
            coveredLength: delta?.coveredLength || 0,
            originalLength: delta?.originalLength || 0,
            retainedLength: delta?.retainedLength || 0,
            chainReset: delta?.chainReset === true,
            chainInputLength: delta?.chainInputLength || null,
            chainLimit: delta?.chainLimit || null
        },
        truncation: {
            truncated: limited?.truncated === true,
            originalLength: limited?.originalLength || 0,
            retainedLength: limited?.retainedLength || 0,
            droppedCount: limited?.droppedCount || 0,
            previousResponseId: limited?.previousResponseId || null
        },
        currentInput: summarizeResponsesInput(sourceRequest?.input, {full}),
        outboundInput: summarizeResponsesInput(outboundRequest?.input, {full}),
        candidates: (delta?.candidates || []).map((candidate) => ({
            responseId: candidate.responseId,
            ...summarizeResponsesInput(candidate.input, {full}),
            comparison: compareResponsesInputsForDiagnostic(sourceRequest?.input, candidate.input)
        }))
    };

    try {
        mkdirSync(path.dirname(filePath), {recursive: true});
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
        log?.warn?.(`Responses continuation diagnostics: failed to write ${filePath}: ${error.message}`);
    }
}

function isDiagnosticEnabled() {
    return isTruthyEnv(process.env.RELAY_RESPONSES_CONTINUATION_DIAG);
}

function isFullDiagnosticEnabled() {
    return isTruthyEnv(process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FULL);
}

function isTruthyEnv(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolveDiagnosticFilePath() {
    const configured = process.env.RELAY_RESPONSES_CONTINUATION_DIAG_FILE || DEFAULT_DIAGNOSTIC_FILE;
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function getDiagnosticDecision(delta) {
    if (delta?.chainReset) return 'chain_reset';
    if (delta?.deltaApplied) return 'delta_applied';
    if (delta?.emptyDelta) return 'empty_delta';
    if (delta?.deltaAttempted) return 'mismatch';
    return 'not_attempted';
}

function summarizeResponsesInput(input, {full} = {}) {
    const items = Array.isArray(input) ? input : [];
    const summary = {
        itemCount: items.length,
        items: items.map((item, index) => summarizeResponsesInputItem(item, index))
    };
    if (full) summary.fullInput = items;
    return summary;
}

function summarizeResponsesInputItem(item, index) {
    return {
        index,
        role: item && typeof item === 'object' ? item.role || null : null,
        type: item && typeof item === 'object' ? item.type || null : null,
        contentTypes: collectContentTypes(item),
        hash: hashDiagnosticValue(item),
        preview: previewDiagnosticValue(item)
    };
}

function collectContentTypes(item) {
    if (!item || typeof item !== 'object') return [];
    if (!Array.isArray(item.content)) return [];
    return item.content
        .map((part) => part && typeof part === 'object' ? part.type || null : typeof part)
        .filter(Boolean);
}

function hashDiagnosticValue(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(stripDiagnosticVolatileFields(value)) || '')
        .digest('hex')
        .slice(0, 16);
}

function previewDiagnosticValue(value) {
    const text = extractDiagnosticText(value).replace(/\s+/g, ' ').trim();
    return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function extractDiagnosticText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(extractDiagnosticText).filter(Boolean).join(' ');
    if (typeof value.text === 'string') return value.text;
    if (typeof value.output === 'string') return value.output;
    if (typeof value.arguments === 'string') return value.arguments;
    if (Array.isArray(value.content)) return value.content.map(extractDiagnosticText).filter(Boolean).join(' ');
    return '';
}

function compareResponsesInputsForDiagnostic(input, previousInput) {
    if (!Array.isArray(input) || !Array.isArray(previousInput)) {
        return {comparable: false, coveredLength: 0, firstMismatch: null};
    }

    const normalizedInput = input.map(normalizeDiagnosticInputItem);
    const normalizedPrevious = previousInput.map(normalizeDiagnosticInputItem);
    let coveredLength = countLeadingIgnorableDiagnosticInputItems(input);
    let matchedInputLength = 0;
    for (
        let previousIndex = countLeadingIgnorableDiagnosticInputItems(previousInput);
        previousIndex < normalizedPrevious.length;
        previousIndex++
    ) {
        if (coveredLength >= normalizedInput.length) {
            return {
                comparable: true,
                coveredLength: matchedInputLength > 0 ? coveredLength : 0,
                firstMismatch: {
                    reason: 'current_input_exhausted',
                    previousIndex,
                    currentIndex: coveredLength,
                    previous: summarizeResponsesInputItem(previousInput[previousIndex], previousIndex),
                    current: null
                }
            };
        }
        if (normalizedInput[coveredLength] === normalizedPrevious[previousIndex]) {
            coveredLength++;
            matchedInputLength++;
            continue;
        }
        if (isSkippableDiagnosticCoveredOutput(previousInput[previousIndex])) continue;
        return {
            comparable: true,
            coveredLength: matchedInputLength > 0 ? coveredLength : 0,
            firstMismatch: {
                reason: 'item_mismatch',
                previousIndex,
                currentIndex: coveredLength,
                previous: summarizeResponsesInputItem(previousInput[previousIndex], previousIndex),
                current: summarizeResponsesInputItem(input[coveredLength], coveredLength)
            }
        };
    }

    return {
        comparable: true,
        coveredLength: matchedInputLength > 0 ? coveredLength : 0,
        firstMismatch: null
    };
}

function normalizeDiagnosticInputItem(value) {
    return JSON.stringify(stripDiagnosticVolatileFields(value));
}

function stripDiagnosticVolatileFields(value) {
    if (Array.isArray(value)) return value.map(stripDiagnosticVolatileFields);
    if (!value || typeof value !== 'object') return value;

    const volatileUserText = normalizeDiagnosticVolatileUserText(value);
    if (volatileUserText !== null) {
        return {
            role: value.role,
            content: volatileUserText
        };
    }

    const result = {};
    for (const key of Object.keys(value).sort()) {
        if (key === 'id' || key === 'status' || key === 'annotations' || key === 'partial') continue;
        result[key] = stripDiagnosticVolatileFields(value[key]);
    }
    return result;
}

function normalizeDiagnosticVolatileUserText(item) {
    if (item?.role !== 'user') return null;
    const text = extractDiagnosticText(item.content).replace(/\s+/g, ' ').trim();
    if (!text.startsWith('[Request interrupted by user]')) return null;
    return text;
}

function isSkippableDiagnosticCoveredOutput(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.role === 'assistant') return true;
    return item.type === 'reasoning' || item.type === 'function_call';
}

function countLeadingIgnorableDiagnosticInputItems(input) {
    let count = 0;
    while (isIgnorableLeadingDiagnosticInputItem(input[count])) count++;
    return count;
}

function isIgnorableLeadingDiagnosticInputItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.role !== 'user') return false;
    return extractDiagnosticText(item.content).trim().startsWith('<system-reminder>');
}
