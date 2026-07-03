import {injectBehaviorRules} from '../../anthropic-adapter.js';
import {
    mergeConsecutiveAssistantMessages,
    prepareOpenAIChatUpstreamRequest,
    stripDynamicReminders
} from '../../protocol-adapter.js';

export function prepareCodebuddyOutboundChatRequest(chatRequest, {model, stream} = {}) {
    const outbound = prepareOpenAIChatUpstreamRequest(chatRequest, {
        model,
        stream,
        clone: false,
        stripUnknownFields: true
    });
    outbound.messages = injectBehaviorRules(outbound.messages || [], outbound.model);
    outbound.messages = stripDynamicReminders(outbound.messages);
    mergeConsecutiveAssistantMessages(outbound.messages);
    return outbound;
}
