/**
 * 一次性脚本：清理凭证轮换残留数据
 * 1. 删除 tenant_states 表中 auto_rotation_enabled、rotation_count、manual_selected_index 列（如果存在）
 * 2. 确保 codebuddy 租户的 current_index 指向第一个可用凭证
 *    - 如果之前没有手动选过活跃凭证（current_index 指向已禁用/不存在的凭证），则默认设为第一个未禁用凭证
 * 用法: node scripts/cleanup-rotation.js
 */

import {Sequelize} from 'sequelize';

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

async function dropColumnsIfExist(tableName, columns) {
    const [results] = await sequelize.query(`SHOW COLUMNS FROM \`${tableName}\``);
    const existingCols = new Set(results.map(r => r.Field));

    for (const col of columns) {
        if (existingCols.has(col)) {
            await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${col}\``);
            console.log(`  已删除列 ${tableName}.${col}`);
        } else {
            console.log(`  列 ${tableName}.${col} 不存在，跳过`);
        }
    }
}

async function fixCurrentIndex() {
    // 查找所有 codebuddy 租户及其状态和凭证
    const [rows] = await sequelize.query(`
        SELECT t.id AS tenant_id, t.name,
               ts.id AS state_id, ts.current_index, ts.disabled_indexes,
               COUNT(tc.id) AS credential_count,
               GROUP_CONCAT(
                   CASE WHEN tc.disabled = 0 THEN tc.id ELSE NULL END
                   ORDER BY tc.id ASC
               ) AS enabled_credential_ids
        FROM tenants t
        LEFT JOIN tenant_states ts ON ts.tenant_id = t.id
        LEFT JOIN tenant_credentials tc ON tc.tenant_id = t.id
        WHERE t.service_type = 'codebuddy'
        GROUP BY t.id, t.name, ts.id, ts.current_index, ts.disabled_indexes
    `);

    let fixed = 0;
    for (const row of rows) {
        if (!row.state_id || row.credential_count === 0) continue;

        const disabledIndexes = JSON.parse(row.disabled_indexes || '[]');
        const enabledIds = row.enabled_credential_ids ? row.enabled_credential_ids.split(',').map(Number) : [];

        if (enabledIds.length === 0) {
            console.log(`  租户 "${row.name}" (id=${row.tenant_id}): 没有可用凭证，跳过`);
            continue;
        }

        // 检查 current_index 是否指向可用凭证
        const currentIdx = row.current_index ?? 0;
        const isValid = currentIdx >= 0 && currentIdx < row.credential_count && !disabledIndexes.includes(currentIdx);

        if (!isValid) {
            // 默认设为第一个（index 0），即第一个未禁用的凭证
            // 由于凭证按 id ASC 排列，第一个可用凭证的 index 就是最小的未禁用 index
            let newIdx = 0;
            for (let i = 0; i < row.credential_count; i++) {
                if (!disabledIndexes.includes(i)) {
                    newIdx = i;
                    break;
                }
            }

            await sequelize.query(
                'UPDATE tenant_states SET current_index = ? WHERE id = ?',
                {replacements: [newIdx, row.state_id]}
            );
            console.log(`  租户 "${row.name}" (id=${row.tenant_id}): current_index ${currentIdx} -> ${newIdx}`);
            fixed++;
        } else {
            console.log(`  租户 "${row.name}" (id=${row.tenant_id}): current_index=${currentIdx} 有效，无需修改`);
        }
    }

    return fixed;
}

async function main() {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 1. 删除残留的轮换列
    console.log('=== 清理 tenant_states 表中残留的轮换列 ===');
    await dropColumnsIfExist('tenant_states', ['auto_rotation_enabled', 'rotation_count', 'manual_selected_index']);

    // 2. 修复 codebuddy 租户的 current_index
    console.log('\n=== 修复 codebuddy 租户的活跃凭证索引 ===');
    const fixed = await fixCurrentIndex();

    console.log(`\n完成，共修复 ${fixed} 个租户的 current_index`);
    await sequelize.close();
}

main().catch(e => {
    console.error('脚本执行失败:', e);
    process.exit(1);
});
