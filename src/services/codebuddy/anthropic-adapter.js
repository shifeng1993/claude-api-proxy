/**
 * CodeBuddy Anthropic adapter.
 * Product-specific wrapper around the core protocol engine.
 * @module services/codebuddy/anthropic-adapter
 */

import logger from '../../utils/logger.js';
import {anthropicRequestToChat} from '../../core/protocol/http-converters.js';
import {injectBehaviorRules} from '../shared/behavior-rules.js';
import {
    openAIToAnthropic as sharedOpenAIToAnthropic
} from '../../core/protocol/shared.js';

export function anthropicToOpenAI(anthropicPayload) {
    return anthropicRequestToChat(anthropicPayload, {
        cleanToolSchema: true,
        logger
    });
}

export function convertToolCallId(codebuddyId) {
    if (codebuddyId && codebuddyId.startsWith('tooluse_')) {
        return `call_${codebuddyId.slice(8)}`;
    }
    return codebuddyId;
}

export function openAIToAnthropic(openAIResponse) {
    return sharedOpenAIToAnthropic(openAIResponse, {logger});
}

export {injectBehaviorRules};
export {rewriteOpenAIStream} from '../../core/protocol/shared.js';
