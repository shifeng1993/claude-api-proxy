import {existsSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';
import {dirname} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const BACKUP_DIR = join(PROJECT_ROOT, 'backups');

function getTimestamp() {
    return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

async function main() {
    const timestamp = getTimestamp();

    if (!existsSync(BACKUP_DIR)) {
        mkdirSync(BACKUP_DIR, {recursive: true});
    }

    try {
        const {initDb, sequelize} = await import('../src/db/index.js');
        const {models} = await import('../src/db/models/index.js');

        await initDb();

        const [tenants, credentials, upstreams, dailyUsage, states] = await Promise.all([
            models.Tenant.findAll({raw: true}),
            models.TenantCredential.findAll({raw: true}),
            models.TenantUpstream.findAll({raw: true}),
            models.TenantDailyUsage.findAll({raw: true}),
            models.TenantState.findAll({raw: true}),
        ]);

        const exportData = {
            tenants,
            credentials,
            upstreams,
            dailyUsage,
            states,
            exportedAt: new Date().toISOString(),
        };

        const jsonBackup = join(BACKUP_DIR, `claude-proxy-${timestamp}.json`);
        writeFileSync(jsonBackup, JSON.stringify(exportData, null, 2), 'utf-8');
        console.log(`JSON 备份已创建: ${jsonBackup}`);

        await sequelize.close();
    } catch (err) {
        console.error('JSON 导出失败:', err.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('备份失败:', err.message);
    process.exit(1);
});
