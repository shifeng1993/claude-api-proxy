import {
    createResponsesInputDelta,
    limitResponsesInputItems
} from './protocol-adapter.js';
import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from '../../utils/logger.js';

const DEFAULT_DIAGNOSTIC_FILE = path.join('logs', 'responses-continuation-diagnostics.jsonl');

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
    const delta = createContinuationDelta(prepared.request, prepared);
    const previousResponseId = delta.deltaApplied
        ? delta.previousResponseId
        : delta.deltaAttempted
            ? null
            : prepared.lastResponseId;
    const limited = limitResponsesInputItems(delta.request, {previousResponseId});

    if (limited.truncated) {
        log.info(
            `Responses continuation: truncated input items ${limited.originalLength}->${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${limited.previousResponseId}`
        );
    }
    if (delta.deltaApplied) {
        log.info(
            `Responses continuation: delta input items ${delta.originalLength}->${delta.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${delta.previousResponseId}`
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
    } else if (delta.emptyDelta) {
        log.info(
            `Responses continuation: delta input empty; websocket auto-link disabled`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${delta.previousResponseId || prepared.lastResponseId}`
        );
    } else if (delta.deltaAttempted) {
        log.info(
            `Responses continuation: delta input mismatch; websocket auto-link disabled`
            + ` upstream input items=${countResponsesInputItems(limited.payload?.input)}`
            + ` source_input_items=${countResponsesInputItems(prepared.request?.input)}`
            + ` retained_input_items=${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${delta.previousResponseId || prepared.lastResponseId}`
            + ` upstream_previous_response_id=${normalizeResponseId(limited.payload?.previous_response_id) || 'none'}`
            + ` autoLink=false`
        );
    }
    const autoLink = !(delta.deltaAttempted && !delta.deltaApplied);

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
        request: limited.payload,
        conversationKey: stateConversationKey,
        lastResponseId: prepared.lastResponseId,
        autoLink,
        skipInputItemLimit: false,
        deltaApplied: delta.deltaApplied,
        deltaAttempted: delta.deltaAttempted,
        emptyDelta: delta.emptyDelta === true,
        deltaPreviousResponseId: delta.previousResponseId || null,
        deltaCoveredLength: delta.coveredLength,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        retainedLength: limited.retainedLength,
        droppedCount: limited.droppedCount
    };
}

function createContinuationDelta(request, prepared) {
    const candidates = getContinuationCandidates(request, prepared);
    const deltaAttempted = Boolean(
        candidates.length > 0
        && Array.isArray(request?.input)
    );
    if (!deltaAttempted) {
        return {
            request,
            deltaAttempted: false,
            deltaApplied: false,
            emptyDelta: false,
            candidates,
            originalLength: Array.isArray(request?.input) ? request.input.length : 0,
            retainedLength: Array.isArray(request?.input) ? request.input.length : 0,
            coveredLength: 0,
            previousResponseId: null
        };
    }

    const best = selectBestContinuationDelta(request.input, candidates);
    if (!best) {
        return {
            request,
            deltaAttempted: true,
            deltaApplied: false,
            emptyDelta: false,
            candidates,
            originalLength: request.input.length,
            retainedLength: request.input.length,
            coveredLength: 0,
            previousResponseId: candidates[0]?.responseId || null
        };
    }
    if (best.emptyDelta) {
        return {
            request,
            deltaAttempted: true,
            deltaApplied: false,
            emptyDelta: true,
            candidates,
            originalLength: best.originalLength,
            retainedLength: best.retainedLength,
            coveredLength: best.coveredLength,
            previousResponseId: best.responseId
        };
    }

    return {
        request: {
            ...request,
            input: best.input,
            previous_response_id: request.previous_response_id || best.responseId
        },
        deltaAttempted: true,
        deltaApplied: true,
        emptyDelta: false,
        candidates,
        originalLength: best.originalLength,
        retainedLength: best.retainedLength,
        coveredLength: best.coveredLength,
        previousResponseId: best.responseId
    };
}

function selectBestContinuationDelta(input, candidates) {
    let best = null;

    for (const candidate of candidates) {
        const delta = createResponsesInputDelta(input, candidate.input);
        if (!delta.deltaApplied) continue;

        const matched = {
            ...delta,
            responseId: candidate.responseId,
            emptyDelta: delta.retainedLength <= 0
        };
        if (!best || matched.coveredLength > best.coveredLength) {
            best = matched;
        }
    }

    return best;
}

function getContinuationCandidates(request, prepared) {
    const explicitPreviousResponseId = normalizeResponseId(request?.previous_response_id);
    const snapshots = Array.isArray(prepared?.responseInputSnapshots)
        ? prepared.responseInputSnapshots
        : [];
    const candidates = [];
    const seen = new Set();

    const addCandidate = (responseId, input) => {
        const normalizedResponseId = normalizeResponseId(responseId);
        if (!normalizedResponseId || seen.has(normalizedResponseId) || !Array.isArray(input) || input.length <= 0) return;
        seen.add(normalizedResponseId);
        candidates.push({responseId: normalizedResponseId, input});
    };

    if (explicitPreviousResponseId) {
        const explicitSnapshot = snapshots.find((snapshot) =>
            normalizeResponseId(snapshot?.responseId) === explicitPreviousResponseId
        );
        addCandidate(explicitSnapshot?.responseId, explicitSnapshot?.input);
        if (normalizeResponseId(prepared?.lastResponseId) === explicitPreviousResponseId) {
            addCandidate(prepared.lastResponseId, prepared.lastResponseInput);
        }
        return candidates;
    }

    for (const snapshot of snapshots) {
        addCandidate(snapshot?.responseId, snapshot?.input);
    }
    addCandidate(prepared?.lastResponseId, prepared?.lastResponseInput);
    return candidates;
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
            retainedLength: delta?.retainedLength || 0
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
