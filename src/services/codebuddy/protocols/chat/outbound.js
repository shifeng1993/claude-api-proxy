import {injectBehaviorRules} from '../../anthropic-adapter.js';
import {
    mergeConsecutiveAssistantMessages,
    prepareOpenAIChatUpstreamRequest,
    stripDynamicReminders
} from '../../protocol-adapter.js';
import {getModelMaxOutputTokens} from '../../config.js';

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

    // glm-5.2 等 onlyReasoning 模型要求 max_tokens 必填，缺失上游返回 400 invalid parameter value。
    // 优先用 .env CODEBUDDY_MODEL_OVERRIDES 中该模型配置的 maxOutputTokens（如 glm-5.2=48000，
    // 即 CodeBuddy 官方推荐值），未配置的模型用安全默认 32000。
    if (outbound.max_tokens === undefined) {
        outbound.max_tokens = getModelMaxOutputTokens(outbound.model) ?? 32000;
    }
    return outbound;
}
