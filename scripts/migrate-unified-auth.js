#!/usr/bin/env node
/**
 * 统一认证数据迁移脚本
 *
 * 将旧的双 service_type 租户模型迁移到统一模型:
 *   1. 备份当前数据库 (mysqldump)
 *   2. 按 username 分组租户
 *   3. 合并 relay + codebuddy 租户记录为统一租户
 *   4. 将 stats 迁移到 TenantServiceProfile
 *   5. 更新关联表的外键 (tenant_upstreams, tenant_credentials 等)
 *   6. 删除 tenants 表上的 service_type 和 stats 旧列
 *
 * 用法: node scripts/migrate-unified-auth.js [--dry-run]
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import '../src/load-env.js';
import { sequelize } from '../src/db/index.js';
import logger from '../src/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

// Old stats columns to be dropped from tenants table
const STATS_COLUMNS = [
    'service_type',
    'total_api_calls',
    'total_input_tokens',
    'total_output_tokens',
    'total_cache_hit_tokens',
    'total_credit'
];

// Tables with a tenant_id foreign key that need FK updates during merge
const RELATED_TABLES = [
    'tenant_upstreams',
    'tenant_credentials',
    'tenant_daily_usage',
    'tenant_states',
    'feedbacks',
    'api_samples',
    'ai_assessments'
];

/**
 * Backup the MySQL database using mysqldump
 */
function backupDatabase() {
    const backupDir = join(PROJECT_ROOT, 'data', 'backups');
    if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
    const backupPath = join(backupDir, `db-pre-unified-auth-${ts}.sql`);

    const host = process.env.DB_HOST || '127.0.0.1';
    const port = process.env.DB_PORT || '3306';
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASSWORD || '';
    const dbName = process.env.DB_NAME || 'claude_api_proxy';

    const cmd = `mysqldump -h ${host} -P ${port} -u ${user} -p"${password}" --single-transaction --routines --triggers ${dbName} > "${backupPath}"`;

    logger.info(`Running mysqldump to ${backupPath} ...`);
    execSync(cmd, { stdio: 'pipe' });
    logger.info(`Database backed up to ${backupPath}`);

    return backupPath;
}

/**
 * Check which old columns still exist on the tenants table
 */
async function getOldColumns() {
    const [rows] = await sequelize.query(`SHOW COLUMNS FROM tenants`);
    const existingCols = rows.map(r => r.Field);
    return STATS_COLUMNS.filter(c => existingCols.includes(c));
}

async function migrate() {
    const db = sequelize;

    // Step 0: Ensure DB connection and sync new tables (via raw SQL to avoid Sequelize model registration issues)
    const {initDb} = await import('../src/db/index.js');
    await initDb();

    // Ensure the new tables exist (sequelize.sync may not pick up new models registered separately)
    await db.query(`CREATE TABLE IF NOT EXISTS tenant_service_profiles (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        tenant_id INTEGER NOT NULL,
        service_type VARCHAR(32) NOT NULL,
        enabled TINYINT(1) DEFAULT 1,
        total_api_calls INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_hit_tokens INTEGER DEFAULT 0,
        total_credit DOUBLE DEFAULT 0,
        created_at DATETIME,
        updated_at DATETIME,
        UNIQUE KEY unique_tenant_service (tenant_id, service_type)
    )`);

    // Step 0.5: Backup
    let backupPath = null;
    if (!dryRun) {
        try {
            backupPath = backupDatabase();
        } catch (err) {
            logger.warn(`mysqldump failed (${err.message}), proceeding without backup`);
        }
    } else {
        logger.info('[DRY RUN] Would backup database with mysqldump');
    }

    // Step 1: Check which old columns still exist
    const oldCols = await getOldColumns();
    const hasServiceType = oldCols.includes('service_type');
    const hasStatsCols = oldCols.some(c => c !== 'service_type');

    if (!hasServiceType && !hasStatsCols) {
        logger.info('tenants table already migrated — no service_type or stats columns found.');
        await sequelize.close();
        return;
    }

    // Step 2: Find all existing tenants
    let query = 'SELECT id, name, api_key_hash, api_key_prefix, api_key_plain, username, is_key_personnel, password_hash, password_salt, role, created_at, updated_at';
    if (hasServiceType) query += ', service_type';
    if (hasStatsCols) {
        query += ', total_api_calls, total_input_tokens, total_output_tokens, total_cache_hit_tokens, total_credit';
    }
    query += ' FROM tenants ORDER BY username, service_type';

    const [tenants] = await db.query(query);

    if (tenants.length === 0) {
        logger.info('No tenants to migrate.');
        await sequelize.close();
        return;
    }

    // Group by username
    const byUsername = new Map();
    for (const t of tenants) {
        const key = t.username || `__nouser_${t.id}`;
        if (!byUsername.has(key)) byUsername.set(key, []);
        byUsername.get(key).push(t);
    }

    const mergeLog = [];

    for (const [username, records] of byUsername) {
        const relay = hasServiceType ? records.find(r => r.service_type === 'relay') : null;
        const codebuddy = hasServiceType ? records.find(r => r.service_type === 'codebuddy') : null;

        // If no service_type column, there's only one record — nothing to merge
        if (!hasServiceType) {
            const keeper = records[0];
            // Still ensure service profiles exist
            if (!dryRun) {
                await ensureServiceProfiles(db, keeper.id, 'relay', keeper);
                await ensureServiceProfiles(db, keeper.id, 'codebuddy', keeper);
            }
            continue;
        }

        if (!relay && !codebuddy) continue;

        // Keep the relay record if both exist, otherwise keep whichever exists
        const keeper = relay || codebuddy;
        const other = relay && codebuddy ? codebuddy : null;

        if (dryRun) {
            mergeLog.push({
                username,
                keepId: keeper.id,
                keeperServiceType: keeper.service_type,
                removeId: other?.id || null
            });
            continue;
        }

        // Create TenantServiceProfile for the keeper's original service_type
        await ensureServiceProfiles(db, keeper.id, keeper.service_type, keeper);

        if (other) {
            // Create TenantServiceProfile for the other's service_type, copying its stats
            await ensureServiceProfiles(db, keeper.id, other.service_type, other);

            // Update foreign keys in related tables
            for (const table of RELATED_TABLES) {
                try {
                    const [result] = await db.query(
                        `UPDATE ${table} SET tenant_id = ? WHERE tenant_id = ?`,
                        { replacements: [keeper.id, other.id] }
                    );
                    if (result.affectedRows > 0) {
                        logger.info(`  Updated ${result.affectedRows} rows in ${table}: ${other.id} → ${keeper.id}`);
                    }
                } catch (err) {
                    // Table might not exist or no tenant_id column — skip
                    if (!err.message.includes('exist') && !err.message.includes('Unknown column')) {
                        logger.warn(`  Failed to update ${table}: ${err.message}`);
                    }
                }
            }

            // Delete the other tenant
            await db.query(`DELETE FROM tenants WHERE id = ?`, { replacements: [other.id] });

            mergeLog.push({
                username,
                keepId: keeper.id,
                keptServiceType: keeper.service_type,
                removedId: other.id,
                removedServiceType: other.service_type
            });
        }

        // If codebuddy-only, create a disabled relay profile
        if (!relay && codebuddy) {
            await ensureDisabledProfile(db, keeper.id, 'relay');
        }

        // If relay-only, create a disabled codebuddy profile
        if (relay && !codebuddy) {
            await ensureDisabledProfile(db, keeper.id, 'codebuddy');
        }
    }

    // Step: Drop old service_type and stats columns from tenants table
    if (!dryRun && oldCols.length > 0) {
        logger.info(`Dropping old columns from tenants: ${oldCols.join(', ')}`);
        for (const col of oldCols) {
            try {
                await db.query(`ALTER TABLE tenants DROP COLUMN ${col}`);
                logger.info(`  Dropped column: ${col}`);
            } catch (err) {
                logger.warn(`  Failed to drop ${col}: ${err.message}`);
            }
        }
        logger.info('Column cleanup complete.');
    } else if (dryRun && oldCols.length > 0) {
        logger.info(`[DRY RUN] Would drop columns: ${oldCols.join(', ')}`);
    }

    // Summary
    const label = dryRun ? 'DRY RUN' : 'complete';
    logger.info(`\nMigration ${label}:`);
    logger.info(`  Total tenant groups: ${byUsername.size}`);
    logger.info(`  Merged records: ${mergeLog.length}`);
    for (const entry of mergeLog) {
        if (entry.removedId) {
            logger.info(`  ${entry.username}: kept id=${entry.keepId} (${entry.keptServiceType}), removed id=${entry.removedId} (${entry.removedServiceType})`);
        } else {
            logger.info(`  ${entry.username}: kept id=${entry.keepId} (${entry.keeperServiceType}), no merge needed`);
        }
    }

    await sequelize.close();
}

/**
 * Create a TenantServiceProfile if it doesn't exist, populating stats from tenant record
 */
async function ensureServiceProfiles(db, tenantId, serviceType, tenantRecord) {
    const [existing] = await db.query(
        `SELECT id FROM tenant_service_profiles WHERE tenant_id = ? AND service_type = ?`,
        { replacements: [tenantId, serviceType] }
    );
    if (existing.length > 0) return;

    await db.query(
        `INSERT INTO tenant_service_profiles (tenant_id, service_type, enabled,
          total_api_calls, total_input_tokens, total_output_tokens,
          total_cache_hit_tokens, total_credit, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, NOW(), NOW())`,
        {
            replacements: [
                tenantId, serviceType,
                tenantRecord.total_api_calls || 0,
                tenantRecord.total_input_tokens || 0,
                tenantRecord.total_output_tokens || 0,
                tenantRecord.total_cache_hit_tokens || 0,
                tenantRecord.total_credit || 0
            ]
        }
    );
    logger.info(`  Created ${serviceType} service profile for tenant ${tenantId}`);
}

/**
 * Create a disabled service profile if it doesn't exist
 */
async function ensureDisabledProfile(db, tenantId, serviceType) {
    const [existing] = await db.query(
        `SELECT id FROM tenant_service_profiles WHERE tenant_id = ? AND service_type = ?`,
        { replacements: [tenantId, serviceType] }
    );
    if (existing.length > 0) return;

    await db.query(
        `INSERT INTO tenant_service_profiles (tenant_id, service_type, enabled,
          total_api_calls, total_input_tokens, total_output_tokens,
          total_cache_hit_tokens, total_credit, created_at, updated_at)
         VALUES (?, ?, 0, 0, 0, 0, 0, 0, NOW(), NOW())`,
        { replacements: [tenantId, serviceType] }
    );
    logger.info(`  Created disabled ${serviceType} service profile for tenant ${tenantId}`);
}

migrate().catch(err => {
    logger.error('Migration failed:', err);
    process.exit(1);
});
