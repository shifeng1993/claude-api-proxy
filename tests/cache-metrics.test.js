import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractCacheHitTokens,
    openAIUsageToAnthropicUsage
} from '../src/protocol-engine/core/shared.js';
import {anthropicUsageToChatUsage} from '../src/protocol-engine/core/http-converters.js';

/* ==================== extractCacheHitTokens 四协议覆盖 ==================== */

test('extractCacheHitTokens 识别 DeepSeek 的 prompt_cache_hit_tokens', () => {
    assert.equal(extractCacheHitTokens({prompt_cache_hit_tokens: 1200}), 1200);
});

test('extractCacheHitTokens 识别 OpenAI Chat 的 prompt_tokens_details.cached_tokens', () => {
    assert.equal(extractCacheHitTokens({prompt_tokens_details: {cached_tokens: 800}}), 800);
});

test('extractCacheHitTokens 识别 Anthropic 的 cache_read_input_tokens', () => {
    assert.equal(extractCacheHitTokens({cache_read_input_tokens: 5000}), 5000);
});

test('extractCacheHitTokens 识别 Responses 的 input_tokens_details.cached_tokens', () => {
    assert.equal(extractCacheHitTokens({input_tokens_details: {cached_tokens: 600}}), 600);
});

test('extractCacheHitTokens 在没有任何缓存字段时返回 0', () => {
    assert.equal(extractCacheHitTokens({input_tokens: 100, output_tokens: 50}), 0);
});

test('extractCacheHitTokens 对 null/undefined 返回 0', () => {
    assert.equal(extractCacheHitTokens(null), 0);
    assert.equal(extractCacheHitTokens(undefined), 0);
});

/* ==================== anthropicUsageToChatUsage 透传 cache_read ==================== */

test('anthropicUsageToChatUsage 在 prompt_tokens_details 中保留 cached_tokens（cache_read）', () => {
    const usage = anthropicUsageToChatUsage({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 700
    });
    assert.equal(usage.prompt_tokens, 1700);
    assert.equal(usage.completion_tokens, 500);
    assert.equal(usage.total_tokens, 2200);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 700);
});

test('anthropicUsageToChatUsage 在没有缓存字段时返回 0', () => {
    const usage = anthropicUsageToChatUsage({input_tokens: 100, output_tokens: 20});
    assert.equal(usage.prompt_tokens_details.cached_tokens, 0);
});

/* ==================== openAIUsageToAnthropicUsage 不少算 input_tokens ==================== */

test('openAIUsageToAnthropicUsage 不从 provider 自定义 cache 命中字段扣减 prompt_tokens', () => {
    const usage = openAIUsageToAnthropicUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 300
    });

    assert.equal(usage.input_tokens, 1000);
    assert.equal(usage.cache_read_input_tokens, 300);
    assert.equal(usage.output_tokens, 50);
});

test('openAIUsageToAnthropicUsage only subtracts cached_tokens reported inside prompt_tokens_details', () => {
    const usage = openAIUsageToAnthropicUsage({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 300,
        prompt_tokens_details: {cached_tokens: 200}
    });

    assert.equal(usage.input_tokens, 800);
    assert.equal(usage.cache_read_input_tokens, 300);
    assert.equal(usage.output_tokens, 50);
});
