import {limitResponsesInputItems} from './protocol-adapter.js';
import logger from '../../utils/logger.js';

export function prepareResponsesContinuationPayload({
    conversationStore,
    tenantId,
    conversationKey,
    request,
    requestType,
    logger: log = logger
} = {}) {
    const prepared = conversationStore.prepareResponsesPassthrough({
        tenantId,
        conversationKey,
        request
    });
    const stateConversationKey = prepared.conversationKey || conversationKey;
    const limited = limitResponsesInputItems(prepared.request, {
        previousResponseId: prepared.lastResponseId
    });

    if (limited.truncated) {
        log.info(
            `Responses continuation: truncated input items ${limited.originalLength}->${limited.retainedLength}`
            + `${requestType ? ` requestType=${requestType}` : ''}`
            + `${stateConversationKey ? ` conversationKey=${stateConversationKey}` : ''}`
            + ` previous_response_id=${limited.previousResponseId}`
        );
    }

    return {
        request: limited.payload,
        conversationKey: stateConversationKey,
        lastResponseId: prepared.lastResponseId,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
        retainedLength: limited.retainedLength,
        droppedCount: limited.droppedCount
    };
}
