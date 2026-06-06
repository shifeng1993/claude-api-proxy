/**
 * 一次性脚本：从 tenant_registry.json 同步 created_at 到数据库
 * 用法: node scripts/sync-created-at.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Sequelize } from 'sequelize';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const DB_DIALECT = process.env.DB_DIALECT || 'mysql';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'claude_api_proxy';

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    dialect: DB_DIALECT,
    host: DB_HOST,
    port: DB_PORT,
    logging: false
});

async function main() {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 读取 codebuddy 和 relay 的 tenant_registry.json
    const codebuddyPath = join(rootDir, '.codebuddy', 'tenants', 'tenant_registry.json');
    const relayPath = join(rootDir, '.relay', 'tenants', 'tenant_registry.json');

    const createdAtByUsername = {};

    // codebuddy 的 created_at 是秒级时间戳
    try {
        const cbData = JSON.parse(readFileSync(codebuddyPath, 'utf8'));
        for (const [, t] of Object.entries(cbData.tenants || {})) {
            if (t.username && t.created_at) {
                createdAtByUsername[t.username] = t.created_at;
            }
        }
        console.log(`从 codebuddy 读取 ${Object.keys(createdAtByUsername).length} 条记录`);
    } catch (e) {
        console.warn('读取 codebuddy tenant_registry.json 失败:', e.message);
    }

    // relay 的 created_at 也是秒级时间戳，补充 codebuddy 中没有的
    try {
        const relayData = JSON.parse(readFileSync(relayPath, 'utf8'));
        let added = 0;
        for (const [, t] of Object.entries(relayData.tenants || {})) {
            if (t.username && t.created_at && !createdAtByUsername[t.username]) {
                createdAtByUsername[t.username] = t.created_at;
                added++;
            }
        }
        console.log(`从 relay 补充 ${added} 条记录`);
    } catch (e) {
        console.warn('读取 relay tenant_registry.json 失败:', e.message);
    }

    // 查询数据库中所有 tenant
    const [tenants] = await sequelize.query('SELECT id, username, created_at FROM tenants');
    console.log(`数据库中共 ${tenants.length} 条 tenant 记录`);

    let updated = 0;
    for (const tenant of tenants) {
        const correctCreatedAt = createdAtByUsername[tenant.username];
        if (!correctCreatedAt) continue;

        const newDate = new Date(correctCreatedAt * 1000);
        const oldDate = tenant.created_at;

        // 只要时间不一致就更新
        if (!oldDate || new Date(oldDate).getTime() !== newDate.getTime()) {
            await sequelize.query('UPDATE tenants SET created_at = ? WHERE id = ?', {
                replacements: [newDate, tenant.id]
            });
            console.log(`更新 tenant ${tenant.username} (id=${tenant.id}): ${oldDate} -> ${newDate.toISOString()}`);
            updated++;
        }
    }

    console.log(`\n完成，共更新 ${updated} 条记录`);
    await sequelize.close();
}

main().catch(e => {
    console.error('脚本执行失败:', e);
    process.exit(1);
});
