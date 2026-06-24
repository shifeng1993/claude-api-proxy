/**
 * Copilot Anthropic adapter.
 * Product-specific wrapper around the core protocol engine.
 * @module services/copilot/anthropic-adapter
 */

import logger from '../../utils/logger.js';
import {
    anthropicRequestToChat,
    anthropicRequestToResponses,
    responsesResponseToAnthropic
} from '../../core/protocol/http-converters.js';
import {injectBehaviorRules} from '../shared/behavior-rules.js';
import {
    normalizeClaudeModelAlias,
    openAIToAnthropic as sharedOpenAIToAnthropic
} from '../../core/protocol/shared.js';

export function anthropicToOpenAI(anthropicPayload, modelId) {
    const resolvedModel = modelId || translateModelName(anthropicPayload.model);
    return anthropicRequestToChat(anthropicPayload, {
        modelMapper: () => resolvedModel,
        prioritizeCacheControlSystemBlocks: true,
        orderToolResultsByAssistant: false,
        sortToolInput: false,
        toolArgumentsSerializer: serializeToolArgumentsLikeCopilot,
        disableReasoningForModel: (model) => String(model || '').includes('haiku'),
        messagePostProcessor: (messages, {model}) => injectBehaviorRules(messages, model)
    });
}

function translateModelName(model) {
    const alias = normalizeClaudeModelAlias(model);
    if (typeof alias !== 'string') return alias;
    if (alias.startsWith('claude-sonnet-4-')) {
        return alias.replace(/^claude-sonnet-4-.*/, 'claude-sonnet-4');
    }
    if (alias.startsWith('claude-opus-4-')) {
        return alias.replace(/^claude-opus-4-.*/, 'claude-opus-4');
    }
    return alias;
}

function serializeToolArgumentsLikeCopilot(input) {
    return JSON.stringify(input);
}

export function anthropicToResponses(anthropicPayload) {
    return anthropicRequestToResponses(anthropicPayload, {
        modelMapper: translateModelName
    });
}

export function responsesOutputToAnthropic(responsesRes) {
    return responsesResponseToAnthropic(responsesRes);
}

export function openAIToAnthropic(openAIResponse) {
    return sharedOpenAIToAnthropic(openAIResponse, {logger});
}
