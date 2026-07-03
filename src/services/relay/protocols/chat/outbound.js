import {injectBehaviorRules as defaultInjectBehaviorRules} from '../../anthropic-adapter.js';
import {
    cloneOpenAIChatUpstreamRequest,
    mergeConsecutiveAssistantMessages as defaultMergeConsecutiveAssistantMessages,
    prepareOpenAIChatUpstreamRequest,
    stripDynamicReminders as defaultStripDynamicReminders
} from '../../protocol-adapter.js';

export function cloneRelayJson(value) {
    return cloneOpenAIChatUpstreamRequest(value);
}

export function prepareRelayOutboundChatRequest(chatRequest, {
    model,
    stream,
    injectBehaviorRules = defaultInjectBehaviorRules,
    stripDynamicReminders = defaultStripDynamicReminders,
    mergeConsecutiveAssistantMessages = defaultMergeConsecutiveAssistantMessages
} = {}) {
    const outbound = prepareOpenAIChatUpstreamRequest(chatRequest, {model, stream});
    outbound.messages = injectBehaviorRules(outbound.messages || [], outbound.model);
    outbound.messages = stripDynamicReminders(outbound.messages);
    mergeConsecutiveAssistantMessages(outbound.messages);
    return outbound;
}
