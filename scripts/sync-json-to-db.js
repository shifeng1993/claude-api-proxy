/**
 * 增量同步脚本：从 .codebuddy 和 .relay JSON 文件同步数据到 MySQL
 * 支持：新增租户、更新租户累计数据、同步凭证/上游/状态/每日用量
 * 用法: node scripts/sync-json-to-db.js
 */

import {initDb} from '../src/db/index.js';
import {models} from '../src/db/models/index.js';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';
import {Op} from 'sequelize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function readJson(filePath) {
    if (!existsSync(filePath)) return null;
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error(`  [错误] 解析 ${filePath} 失败: ${err.message}`);
        return null;
    }
}

const stats = {
    codebuddy: {newTenants: 0, updatedTenants: 0, newCredentials: 0, newStates: 0, newUsages: 0},
    relay: {newTenants: 0, updatedTenants: 0, newUpstreams: 0, newStates: 0, newUsages: 0}
};

async function syncCodebuddyTenants() {
    const registryPath = join(PROJECT_ROOT, '.codebuddy', 'tenants', 'tenant_registry.json');
    const registry = readJson(registryPath);
    if (!registry) {
        console.log('[CodeBuddy] tenant_registry.json 不存在，跳过');
        return;
    }

    const tenantsData = registry.tenants || {};

    for (const [oldId, data] of Object.entries(tenantsData)) {
        // 按 api_key_hash + service_type 查找是否已存在
        let tenant = await models.Tenant.findOne({
            where: {service_type: 'codebuddy', api_key_hash: data.api_key_hash}
        });

        if (!tenant) {
            // 新增租户
            tenant = await models.Tenant.create({
                service_type: 'codebuddy',
                name: data.name,
                api_key_hash: data.api_key_hash,
                api_key_prefix: data.api_key_prefix,
                api_key_plain: data.api_key_plain,
                username: data.username,
                created_at: data.created_at ? new Date(data.created_at * 1000) : null,
                total_api_calls: data.custom_api_call_count || 0,
                total_input_tokens: data.custom_input_tokens || 0,
                total_output_tokens: data.custom_output_tokens || 0,
                total_cache_hit_tokens: data.custom_cache_hit_tokens || 0,
                total_credit: data.custom_credit || 0
            });
            stats.codebuddy.newTenants++;
            console.log(`[CodeBuddy] 新增租户: ${data.name} (id=${tenant.id})`);
        } else {
            // 更新累计数据
            const updates = {};
            if (data.username && data.username !== tenant.username) updates.username = data.username;
            if (data.name && data.name !== tenant.name) updates.name = data.name;
            if (data.api_key_plain && data.api_key_plain !== tenant.api_key_plain) updates.api_key_plain = data.api_key_plain;
            if (data.api_key_prefix && data.api_key_prefix !== tenant.api_key_prefix) updates.api_key_prefix = data.api_key_prefix;
            if (data.created_at && (!tenant.created_at || new Date(data.created_at * 1000).getTime() !== tenant.created_at.getTime())) {
                updates.created_at = new Date(data.created_at * 1000);
            }

            const newCalls = data.custom_api_call_count || 0;
            const newInput = data.custom_input_tokens || 0;
            const newOutput = data.custom_output_tokens || 0;
            const newCacheHit = data.custom_cache_hit_tokens || 0;
            const newCredit = data.custom_credit || 0;

            if (newCalls !== tenant.total_api_calls) updates.total_api_calls = newCalls;
            if (newInput !== tenant.total_input_tokens) updates.total_input_tokens = newInput;
            if (newOutput !== tenant.total_output_tokens) updates.total_output_tokens = newOutput;
            if (newCacheHit !== tenant.total_cache_hit_tokens) updates.total_cache_hit_tokens = newCacheHit;
            if (newCredit !== tenant.total_credit) updates.total_credit = newCredit;

            if (Object.keys(updates).length > 0) {
                await tenant.update(updates);
                stats.codebuddy.updatedTenants++;
                console.log(`[CodeBuddy] 更新租户: ${data.name} (id=${tenant.id}, ${Object.keys(updates).join(',')})`);
            }
        }

        // 同步凭证
        const credDir = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'credentials');
        if (existsSync(credDir)) {
            try {
                const credFiles = readdirSync(credDir).filter(f => f.endsWith('.json'));
                for (const file of credFiles) {
                    const cred = readJson(join(credDir, file));
                    if (!cred) continue;

                    // 按 bearer_token 去重
                    const existing = await models.TenantCredential.findOne({
                        where: {tenant_id: tenant.id, bearer_token: cred.bearer_token}
                    });
                    if (existing) continue;

                    await models.TenantCredential.create({
                        tenant_id: tenant.id,
                        bearer_token: cred.bearer_token,
                        refresh_token: cred.refresh_token,
                        token_type: cred.token_type,
                        user_id: cred.user_id,
                        user_email: cred.user_info?.email,
                        user_name: cred.user_info?.name,
                        base_url: cred.base_url,
                        enterprise_id: cred.enterprise_id,
                        enterprise_name: cred.enterprise_name,
                        department_info: cred.department_info,
                        domain: cred.domain,
                        scope: cred.scope,
                        expires_in: cred.expires_in,
                        credential_created_at: cred.created_at
                    });
                    stats.codebuddy.newCredentials++;
                }
            } catch (err) {
                console.error(`  [错误] 读取凭证目录失败: ${err.message}`);
            }
        }

        // 同步状态
        const statePath = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'state.json');
        const state = readJson(statePath);
        if (state) {
            const existingState = await models.TenantState.findOne({where: {tenant_id: tenant.id}});
            if (existingState) {
                await existingState.update({
                    current_index: state.currentIndex ?? existingState.current_index,
                    disabled_indexes: state.disabledIndexes ?? existingState.disabled_indexes,
                    saved_at: state.savedAt ? String(state.savedAt) : existingState.saved_at
                });
            } else {
                await models.TenantState.create({
                    tenant_id: tenant.id,
                    current_index: state.currentIndex ?? 0,
                    disabled_indexes: state.disabledIndexes || [],
                    saved_at: state.savedAt ? String(state.savedAt) : null
                });
                stats.codebuddy.newStates++;
            }
        }

        // 同步每日用量
        const usagePath = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'daily_usage.json');
        const usage = readJson(usagePath);
        if (usage) {
            for (const [month, days] of Object.entries(usage)) {
                for (const [day, dayData] of Object.entries(days)) {
                    const date = `${month}-${day.padStart(2, '0')}`;
                    const cacheHit = dayData.cache_hit_tokens || 0;
                    const inputTotal = dayData.input_tokens || 0;

                    // 查找是否已有该日期的记录
                    const existingUsage = await models.TenantDailyUsage.findOne({
                        where: {tenant_id: tenant.id, service_type: 'codebuddy', model: 'unknown', date}
                    });

                    if (existingUsage) {
                        // 更新为 JSON 中的值（JSON 是最新的真实数据源）
                        await existingUsage.update({
                            api_calls: dayData.api_calls || 0,
                            input_tokens: inputTotal,
                            input_cache_hit: cacheHit,
                            input_cache_miss: cacheHit > 0 ? inputTotal - cacheHit : inputTotal,
                            output_tokens: dayData.output_tokens || 0,
                            credit: dayData.credit || 0
                        });
                    } else {
                        await models.TenantDailyUsage.create({
                            tenant_id: tenant.id,
                            service_type: 'codebuddy',
                            model: 'unknown',
                            date,
                            api_calls: dayData.api_calls || 0,
                            input_tokens: inputTotal,
                            input_cache_hit: cacheHit,
                            input_cache_miss: cacheHit > 0 ? inputTotal - cacheHit : inputTotal,
                            output_tokens: dayData.output_tokens || 0,
                            credit: dayData.credit || 0
                        });
                        stats.codebuddy.newUsages++;
                    }
                }
            }
        }
    }
}

async function syncRelayTenants() {
    const registryPath = join(PROJECT_ROOT, '.relay', 'tenants', 'tenant_registry.json');
    const registry = readJson(registryPath);
    if (!registry) {
        console.log('[Relay] tenant_registry.json 不存在，跳过');
        return;
    }

    const tenantsData = registry.tenants || {};

    for (const [oldId, data] of Object.entries(tenantsData)) {
        let tenant = await models.Tenant.findOne({
            where: {service_type: 'relay', api_key_hash: data.api_key_hash}
        });

        if (!tenant) {
            tenant = await models.Tenant.create({
                service_type: 'relay',
                name: data.name,
                api_key_hash: data.api_key_hash,
                api_key_prefix: data.api_key_prefix,
                api_key_plain: data.api_key_plain,
                username: data.username,
                created_at: data.created_at ? new Date(data.created_at * 1000) : null,
                total_api_calls: data.custom_api_call_count || 0,
                total_input_tokens: data.custom_input_tokens || 0,
                total_output_tokens: data.custom_output_tokens || 0,
                total_cache_hit_tokens: data.custom_cache_hit_tokens || 0,
                total_credit: data.custom_credit || 0
            });
            stats.relay.newTenants++;
            console.log(`[Relay] 新增租户: ${data.name} (id=${tenant.id})`);
        } else {
            const updates = {};
            if (data.username && data.username !== tenant.username) updates.username = data.username;
            if (data.name && data.name !== tenant.name) updates.name = data.name;
            if (data.api_key_plain && data.api_key_plain !== tenant.api_key_plain) updates.api_key_plain = data.api_key_plain;
            if (data.api_key_prefix && data.api_key_prefix !== tenant.api_key_prefix) updates.api_key_prefix = data.api_key_prefix;
            if (data.created_at && (!tenant.created_at || new Date(data.created_at * 1000).getTime() !== tenant.created_at.getTime())) {
                updates.created_at = new Date(data.created_at * 1000);
            }

            const newCalls = data.custom_api_call_count || 0;
            const newInput = data.custom_input_tokens || 0;
            const newOutput = data.custom_output_tokens || 0;
            const newCacheHit = data.custom_cache_hit_tokens || 0;
            const newCredit = data.custom_credit || 0;

            if (newCalls !== tenant.total_api_calls) updates.total_api_calls = newCalls;
            if (newInput !== tenant.total_input_tokens) updates.total_input_tokens = newInput;
            if (newOutput !== tenant.total_output_tokens) updates.total_output_tokens = newOutput;
            if (newCacheHit !== tenant.total_cache_hit_tokens) updates.total_cache_hit_tokens = newCacheHit;
            if (newCredit !== tenant.total_credit) updates.total_credit = newCredit;

            if (Object.keys(updates).length > 0) {
                await tenant.update(updates);
                stats.relay.updatedTenants++;
                console.log(`[Relay] 更新租户: ${data.name} (id=${tenant.id}, ${Object.keys(updates).join(',')})`);
            }
        }

        // 同步上游
        const upstreamsPath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'upstreams.json');
        const upstreamsData = readJson(upstreamsPath);
        if (Array.isArray(upstreamsData)) {
            // 先清除旧的上游再重新写入，因为上游列表可能增减
            await models.TenantUpstream.destroy({where: {tenant_id: tenant.id}});
            for (const up of upstreamsData) {
                await models.TenantUpstream.create({
                    tenant_id: tenant.id,
                    name: up.name,
                    base_url: up.base_url,
                    api_key: up.api_key,
                    proxy: up.proxy,
                    models: up.models || [],
                    model_map: up.model_map || {},
                    model_auto: up.model_auto ?? true,
                    protocol: up.protocol,
                    retry_count: up.retry_count ?? 3,
                    enabled: up.enabled ?? true
                });
            }
            stats.relay.newUpstreams += upstreamsData.length;
        }

        // 同步设置 → TenantState
        const settingsPath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'settings.json');
        const settings = readJson(settingsPath);
        if (settings) {
            const existingState = await models.TenantState.findOne({where: {tenant_id: tenant.id}});
            if (existingState) {
                await existingState.update({
                    active_upstream_index: settings.activeIndex ?? existingState.active_upstream_index
                });
            } else {
                await models.TenantState.create({
                    tenant_id: tenant.id,
                    active_upstream_index: settings.activeIndex ?? 0
                });
                stats.relay.newStates++;
            }
        }

        // 同步每日用量
        const usagePath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'daily_usage.json');
        const usage = readJson(usagePath);
        if (usage) {
            for (const [month, days] of Object.entries(usage)) {
                for (const [day, dayData] of Object.entries(days)) {
                    const date = `${month}-${day.padStart(2, '0')}`;
                    const cacheHit = dayData.cache_hit_tokens || 0;
                    const inputTotal = dayData.input_tokens || 0;

                    const existingUsage = await models.TenantDailyUsage.findOne({
                        where: {tenant_id: tenant.id, service_type: 'relay', model: 'unknown', date}
                    });

                    if (existingUsage) {
                        await existingUsage.update({
                            api_calls: dayData.api_calls || 0,
                            input_tokens: inputTotal,
                            input_cache_hit: cacheHit,
                            input_cache_miss: cacheHit > 0 ? inputTotal - cacheHit : inputTotal,
                            output_tokens: dayData.output_tokens || 0,
                            credit: dayData.credit || 0
                        });
                    } else {
                        await models.TenantDailyUsage.create({
                            tenant_id: tenant.id,
                            service_type: 'relay',
                            model: 'unknown',
                            date,
                            api_calls: dayData.api_calls || 0,
                            input_tokens: inputTotal,
                            input_cache_hit: cacheHit,
                            input_cache_miss: cacheHit > 0 ? inputTotal - cacheHit : inputTotal,
                            output_tokens: dayData.output_tokens || 0,
                            credit: dayData.credit || 0
                        });
                        stats.relay.newUsages++;
                    }
                }
            }
        }
    }
}

async function main() {
    console.log('=== 开始增量同步 JSON 数据到 MySQL ===\n');

    await initDb();
    console.log('数据库初始化完成\n');

    await syncCodebuddyTenants();
    console.log('');
    await syncRelayTenants();

    console.log('\n=== 同步完成 ===');
    console.log(`CodeBuddy: 新增 ${stats.codebuddy.newTenants} 租户, 更新 ${stats.codebuddy.updatedTenants} 租户, ${stats.codebuddy.newCredentials} 新凭证, ${stats.codebuddy.newStates} 新状态, ${stats.codebuddy.newUsages} 新用量`);
    console.log(`Relay: 新增 ${stats.relay.newTenants} 租户, 更新 ${stats.relay.updatedTenants} 租户, ${stats.relay.newUpstreams} 上游, ${stats.relay.newStates} 新状态, ${stats.relay.newUsages} 新用量`);

    process.exit(0);
}

main().catch(err => {
    console.error('同步失败:', err);
    process.exit(1);
});
