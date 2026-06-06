import {initDb} from '../src/db/index.js';
import {models} from '../src/db/models/index.js';
import {readFileSync, existsSync, readdirSync} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';

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

async function migrateCodebuddyTenants() {
    const registryPath = join(PROJECT_ROOT, '.codebuddy', 'tenants', 'tenant_registry.json');
    const registry = readJson(registryPath);
    if (!registry) {
        console.log('[CodeBuddy] tenant_registry.json 不存在，跳过');
        return {tenants: 0, credentials: 0, states: 0, usages: 0};
    }

    const tenantsData = registry.tenants || {};
    const oldIdMap = {};
    let tenants = 0, credentials = 0, states = 0, usages = 0;

    for (const [oldId, data] of Object.entries(tenantsData)) {
        console.log(`[CodeBuddy] 迁移租户: ${data.name} (${oldId})`);

        const tenant = await models.Tenant.create({
            service_type: 'codebuddy',
            name: data.name,
            api_key_hash: data.api_key_hash,
            api_key_prefix: data.api_key_prefix,
            api_key_plain: data.api_key_plain,
            username: data.username,
            total_api_calls: data.custom_api_call_count || 0,
            total_input_tokens: data.custom_input_tokens || 0,
            total_output_tokens: data.custom_output_tokens || 0,
            total_cache_hit_tokens: data.custom_cache_hit_tokens || 0,
            total_credit: data.custom_credit || 0
        });
        oldIdMap[oldId] = tenant.id;
        tenants++;

        // 迁移凭证
        const credDir = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'credentials');
        if (existsSync(credDir)) {
            try {
                const credFiles = readdirSync(credDir).filter(f => f.endsWith('.json'));
                for (const file of credFiles) {
                    const cred = readJson(join(credDir, file));
                    if (!cred) continue;
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
                    credentials++;
                }
            } catch (err) {
                console.error(`  [错误] 读取凭证目录失败: ${err.message}`);
            }
        }

        // 迁移状态
        const statePath = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'state.json');
        const state = readJson(statePath);
        if (state) {
            await models.TenantState.create({
                tenant_id: tenant.id,
                current_index: state.currentIndex ?? 0,
                disabled_indexes: state.disabledIndexes || [],
                saved_at: state.savedAt ? String(state.savedAt) : null
            });
            states++;
        }

        // 迁移每日用量
        const usagePath = join(PROJECT_ROOT, '.codebuddy', 'tenants', oldId, 'daily_usage.json');
        const usage = readJson(usagePath);
        if (usage) {
            for (const [month, days] of Object.entries(usage)) {
                for (const [day, dayData] of Object.entries(days)) {
                    const date = `${month}-${day.padStart(2, '0')}`;
                    const cacheHit = dayData.cache_hit_tokens || 0;
                    const inputTotal = dayData.input_tokens || 0;
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
                    usages++;
                }
            }
        }
    }

    return {tenants, credentials, states, usages};
}

async function migrateRelayTenants() {
    const registryPath = join(PROJECT_ROOT, '.relay', 'tenants', 'tenant_registry.json');
    const registry = readJson(registryPath);
    if (!registry) {
        console.log('[Relay] tenant_registry.json 不存在，跳过');
        return {tenants: 0, upstreams: 0, states: 0, usages: 0};
    }

    const tenantsData = registry.tenants || {};
    let tenants = 0, upstreams = 0, states = 0, usages = 0;

    for (const [oldId, data] of Object.entries(tenantsData)) {
        console.log(`[Relay] 迁移租户: ${data.name} (${oldId})`);

        const tenant = await models.Tenant.create({
            service_type: 'relay',
            name: data.name,
            api_key_hash: data.api_key_hash,
            api_key_prefix: data.api_key_prefix,
            api_key_plain: data.api_key_plain,
            username: data.username,
            total_api_calls: data.custom_api_call_count || 0,
            total_input_tokens: data.custom_input_tokens || 0,
            total_output_tokens: data.custom_output_tokens || 0,
            total_cache_hit_tokens: data.custom_cache_hit_tokens || 0,
            total_credit: data.custom_credit || 0
        });
        tenants++;

        // 迁移上游
        const upstreamsPath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'upstreams.json');
        const upstreamsData = readJson(upstreamsPath);
        if (Array.isArray(upstreamsData)) {
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
                upstreams++;
            }
        }

        // 迁移设置 → 更新 TenantState
        const settingsPath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'settings.json');
        const settings = readJson(settingsPath);
        if (settings) {
            await models.TenantState.create({
                tenant_id: tenant.id,
                active_upstream_index: settings.activeIndex ?? 0
            });
            states++;
        }

        // 迁移每日用量
        const usagePath = join(PROJECT_ROOT, '.relay', 'tenants', oldId, 'daily_usage.json');
        const usage = readJson(usagePath);
        if (usage) {
            for (const [month, days] of Object.entries(usage)) {
                for (const [day, dayData] of Object.entries(days)) {
                    const date = `${month}-${day.padStart(2, '0')}`;
                    const cacheHit = dayData.cache_hit_tokens || 0;
                    const inputTotal = dayData.input_tokens || 0;
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
                    usages++;
                }
            }
        }
    }

    return {tenants, upstreams, states, usages};
}

async function main() {
    console.log('=== 开始迁移 JSON 数据到 MySQL 数据库 ===\n');

    await initDb();
    console.log('数据库初始化完成\n');

    const count = await models.Tenant.count();
    if (count > 0) {
        console.log('数据库已有数据，跳过迁移');
        process.exit(0);
    }

    const cb = await migrateCodebuddyTenants();
    const relay = await migrateRelayTenants();

    console.log('\n=== 迁移完成 ===');
    console.log(`CodeBuddy: ${cb.tenants} 租户, ${cb.credentials} 凭证, ${cb.states} 状态, ${cb.usages} 用量记录`);
    console.log(`Relay: ${relay.tenants} 租户, ${relay.upstreams} 上游, ${relay.states} 状态, ${relay.usages} 用量记录`);

    process.exit(0);
}

main().catch(err => {
    console.error('迁移失败:', err);
    process.exit(1);
});
