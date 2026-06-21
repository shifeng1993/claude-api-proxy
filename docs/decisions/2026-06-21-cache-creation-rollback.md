# 决策记录：cacheCreation 回滚后的两处遗留 (2026-06-21)

写缓存（cacheCreation）token 追踪在 06-19 至 06-21 之间引入又删除（详见提交 dd39718..860f260，集中在 f79414e）。回滚过程中两处「不彻底」是有意为之，不是漏删。本文档记录决策与边界，避免后人翻 [`.specstory/plan.md`](../../.specstory/plan.md) 推倒重来。

## 决策 1：保留 `tenant_daily_usage.input_cache_creation` 与 `tenant_service_profiles.total_cache_creation_tokens` 两列

**做了什么**

- 删除：Sequelize 模型字段声明、`ensureTenantDailyUsageColumns`/`ensureTenantServiceProfileColumns` 启动迁移、所有写入路径。
- 保留：数据库里已存在的两个物理列（已部署实例上有历史数据），新部署不再创建。

**为什么不 DROP**

- SQLite 的 `DROP COLUMN` 在旧版本上需要重建整张表（CREATE NEW + INSERT SELECT + DROP OLD + RENAME），表里有几百万行历史数据时迁移代价高且有失败风险。
- 列在 Sequelize 模型里不声明 → ORM 既不读也不写，相当于死字段。空间占用是新行 8B × 2 列的常数，每天百万行也只是 ~16 MB/天，可接受。
- 一旦未来确实需要做 `VACUUM` 类整理，可以借机一并 `ALTER TABLE ... DROP COLUMN`（现代 SQLite 已支持 `DROP COLUMN`，但旧库可能还在 3.34 之前）。

**结论**：留空列无害。**禁止后续 PR 单独跑迁移去 DROP 这两列** —— 没有收益，只有风险。

**触发重新评估的条件**：
- 升级到 PostgreSQL / 其它非 SQLite 后端（DROP COLUMN 零代价，可以做）。
- 表行数小、可以接受重建（例如重新初始化租户库）。

## 决策 2：保留 `input_cache_miss = input - hit` 派生量落库

**做了什么**

[`src/services/gateway/tenant-manager.js:212-218`](../../src/services/gateway/tenant-manager.js#L212-L218)：

```js
const cacheMiss = Math.max(0, effectiveInput - effectiveHit);
await record.increment({
    ...
    input_cache_hit: effectiveHit,
    input_cache_miss: cacheMiss,
    ...
});
```

`miss = max(0, input - hit)` 与 `input`、`hit` **同时**落到 `tenant_daily_usage` 同一行。

**为什么不依赖前端/查询时派生**

- **聚合性能**：命中率仪表盘聚合是 `SUM(miss) / SUM(input + miss)`，按租户 × 服务 × 日期分组。让 SQL 直接 `SUM` 一个已落库的列，避免每次查询都重算 `MAX(0, input - hit)` 表达式 ×百万行。
- **历史口径稳定**：`input_tokens` 在 d491b94 之后从 `extractInputTokens()` 取值（含 cache_read + cache_creation），口径变过一次。`hit` 取 `extractCacheHitTokens()`。把 miss 在写入时一次性算定，相当于把当时的口径冻结在该行；之后即使再改 helper，历史 miss 仍是当时的真实值，不会因为口径漂移而失真。
- `Math.max(0, ...)` 兜底了上游 usage 字段错乱时 input < hit 的边缘场景，避免出现负数。

**不一致风险**：
- 仅当有人手动 UPDATE `input_tokens` 或 `input_cache_hit` 而不同步更新 `input_cache_miss` 时才出问题。这种场景不应该发生（数据修复走脚本，脚本写新行而不是改老行）。
- 命中率统计本身允许小误差（用于趋势观察，不是计费）。

**结论**：派生量重复落库换得查询性能与口径稳定，**保持现状**。

**触发重新评估的条件**：
- 上游 usage 口径再次大改、需要重算历史命中率（这时直接重写整张表的 miss 列即可，不是删除该字段的理由）。
- 切换到列存或时序后端，`SUM(input + miss)` 的实时计算变得便宜。

## 关联

- 计划/讨论留底：[`.specstory/plan.md`](../../.specstory/plan.md)
- 触发回滚的提交：`f79414e` (`fix: drop cache_creation token tracking and fix 3 relay bugs`)
- 反向保护断言：[`tests/template-naming.test.js`](../../tests/template-naming.test.js)（admin.html / dashboard-frontend.js 不得再含 `cacheCreation`）
- `extractInputTokens` 仍把 `cache_creation_input_tokens` 计入总输入是另一个有意保留 —— 它属于 Anthropic 原生计费定义而非 cacheCreation 独立维度，见 [`src/transformer/shared-translator.js:32-34`](../../src/transformer/shared-translator.js#L32-L34)
