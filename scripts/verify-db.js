/**
 * 数据库连接 + sync 验证脚本（一次性使用）
 * 用法: node scripts/verify-db.js
 *
 * 行为:
 *   1. 加载 .env / .env.local
 *   2. 连接配置中的 DB
 *   3. 加载所有模型，sync() 创建表
 *   4. 打印连接信息和表清单
 */
import '../src/load-env.js';
import {sequelize, initDb} from '../src/db/index.js';
import '../src/db/models/index.js';

const start = Date.now();
console.log('[db] 连接目标:', {
    dialect: process.env.DB_DIALECT,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    database: process.env.DB_NAME
});

try {
    await initDb();
    console.log(`[db] 连接 + sync 成功 (${Date.now() - start}ms)`);

    const [rows] = await sequelize.query('SHOW TABLES');
    const tableKey = `Tables_in_${process.env.DB_NAME}`;
    const tables = rows.map((r) => r[tableKey]);
    console.log(`[db] 已建表 ${tables.length} 张:`);
    for (const t of tables) console.log('  -', t);

    await sequelize.close();
    process.exit(0);
} catch (e) {
    console.error('[db] 失败:', e.message);
    if (e.original) console.error('     原因:', e.original.code || e.original.message);
    process.exit(1);
}
