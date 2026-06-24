/**
 * Relay Anthropic adapter.
 * Product-specific wrapper around the core protocol engine.
 * @module services/relay/anthropic-adapter
 */

import logger from '../../utils/logger.js';
import {anthropicRequestToChat} from '../../core/protocol/http-converters.js';
import {injectBehaviorRules} from '../shared/behavior-rules.js';
import {
    mapStopReason,
    openAIToAnthropic as sharedOpenAIToAnthropic
} from '../../core/protocol/shared.js';

export function anthropicToOpenAI(anthropicPayload) {
    return anthropicRequestToChat(anthropicPayload, {
        cleanToolSchema: true,
        logger
    });
}

export function openAIToAnthropic(openAIResponse) {
    return sharedOpenAIToAnthropic(openAIResponse, {logger});
}

export {injectBehaviorRules, mapStopReason};
