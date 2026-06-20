import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractCacheHitTokens,
    extractCacheCreationTokens,
    extractCacheMetrics
} from '../src/transformer/shared-translator.js';
import {anthropicUsageToChatUsage} from '../src/routes/relay-protocol-converters.js';

/* ==================== extractCacheMetrics 统一提取 ==================== */

test('extractCacheMetrics 识别 DeepSeek 的 prompt_cache_hit_tokens', () => {
    const metrics = extractCacheMetrics({
        prompt_cache_hit_tokens: 1200,
        prompt_cache_miss_tokens: 300
    });
    assert.equal(metrics.cacheHit, 1200);
    assert.equal(metrics.cacheCreation, 0);
});

test('extractCacheMetrics 识别 OpenAI Chat 的 prompt_tokens_details.cached_tokens', () => {
    const metrics = extractCacheMetrics({
        prompt_tokens_details: {cached_tokens: 800}
    });
    assert.equal(metrics.cacheHit, 800);
    assert.equal(metrics.cacheCreation, 0);
});

test('extractCacheMetrics 识别 Anthropic 的 cache_read_input_tokens + cache_creation_input_tokens', () => {
    const metrics = extractCacheMetrics({
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 2000
    });
    assert.equal(metrics.cacheHit, 5000);
    assert.equal(metrics.cacheCreation, 2000);
});

test('extractCacheMetrics 识别 Responses 的 input_tokens_details.cached_tokens', () => {
    const metrics = extractCacheMetrics({
        input_tokens_details: {cached_tokens: 600}
    });
    assert.equal(metrics.cacheHit, 600);
    assert.equal(metrics.cacheCreation, 0);
});

test('extractCacheMetrics 在没有任何缓存字段时返回 0', () => {
    const metrics = extractCacheMetrics({input_tokens: 100, output_tokens: 50});
    assert.equal(metrics.cacheHit, 0);
    assert.equal(metrics.cacheCreation, 0);
});

test('extractCacheMetrics 对 null/undefined 返回 0', () => {
    assert.deepEqual(extractCacheMetrics(null), {cacheHit: 0, cacheCreation: 0});
    assert.deepEqual(extractCacheMetrics(undefined), {cacheHit: 0, cacheCreation: 0});
});

/* ==================== extractCacheHitTokens 向后兼容（委托统一函数） ==================== */

test('extractCacheHitTokens 仍返回缓存命中 token 数，兼容已有调用点', () => {
    assert.equal(extractCacheHitTokens({prompt_cache_hit_tokens: 100}), 100);
    assert.equal(extractCacheHitTokens({prompt_tokens_details: {cached_tokens: 200}}), 200);
    assert.equal(extractCacheHitTokens({cache_read_input_tokens: 300}), 300);
    assert.equal(extractCacheHitTokens({input_tokens_details: {cached_tokens: 400}}), 400);
    assert.equal(extractCacheHitTokens(null), 0);
});

/* ==================== extractCacheCreationTokens（Anthropic 写缓存成本） ==================== */

test('extractCacheCreationTokens 提取 Anthropic 写缓存成本，其他协议为 0', () => {
    assert.equal(extractCacheCreationTokens({cache_creation_input_tokens: 2000}), 2000);
    assert.equal(extractCacheCreationTokens({prompt_cache_hit_tokens: 100}), 0);
    assert.equal(extractCacheCreationTokens(null), 0);
});

/* ==================== anthropicUsageToChatUsage 透传 cache_creation ==================== */

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
    assert.equal(usage.prompt_tokens_details.cache_creation_tokens, 0);
});

test('anthropicUsageToChatUsage 透传 Anthropic 的 cache_creation_input_tokens 并计入输入总量', () => {
    const usage = anthropicUsageToChatUsage({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 300
    });
    assert.equal(usage.prompt_tokens, 2000);
    assert.equal(usage.total_tokens, 2500);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 700);
    assert.equal(usage.prompt_tokens_details.cache_creation_tokens, 300);
});

test('anthropicUsageToChatUsage 在没有缓存字段时返回 0', () => {
    const usage = anthropicUsageToChatUsage({input_tokens: 100, output_tokens: 20});
    assert.equal(usage.prompt_tokens_details.cached_tokens, 0);
    assert.equal(usage.prompt_tokens_details.cache_creation_tokens, 0);
});

/* ==================== extractCacheCreationTokens 三协议兜底 ==================== */

test('extractCacheCreationTokens 识别 Chat 的 prompt_tokens_details.cache_creation_tokens', () => {
    const usage = {prompt_tokens_details: {cache_creation_tokens: 2500}};
    assert.equal(extractCacheCreationTokens(usage), 2500);
});

test('extractCacheCreationTokens 识别 Responses 的 input_tokens_details.cache_creation_tokens', () => {
    const usage = {input_tokens_details: {cache_creation_tokens: 1800}};
    assert.equal(extractCacheCreationTokens(usage), 1800);
});

test('extractCacheCreationTokens 优先 Anthropic 原生字段', () => {
    const usage = {
        cache_creation_input_tokens: 3000,
        prompt_tokens_details: {cache_creation_tokens: 999},
        input_tokens_details: {cache_creation_tokens: 888}
    };
    assert.equal(extractCacheCreationTokens(usage), 3000);
});

test('extractCacheMetrics 同步返回三协议 cacheCreation', () => {
    assert.equal(extractCacheMetrics({prompt_tokens_details: {cache_creation_tokens: 500}}).cacheCreation, 500);
    assert.equal(extractCacheMetrics({input_tokens_details: {cache_creation_tokens: 700}}).cacheCreation, 700);
    assert.equal(extractCacheMetrics({cache_creation_input_tokens: 900}).cacheCreation, 900);
});
