/**
 * 采样文件存储管理器
 * 管理采样文件的写入、读取和清理
 * @module services/coach/storage
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, statSync} from 'fs';
import {join} from 'path';
import {randomBytes} from 'crypto';
import logger from '../../utils/logger.js';

const SAMPLES_DIR = join(process.cwd(), 'data', 'coach-samples');

/**
 * 确保目录存在
 * @param {string} dir
 */
function ensureDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, {recursive: true});
    }
}

/**
 * 规范化租户ID为数字（去掉 'tenant_' 前缀）
 * @param {string|number} id
 * @returns {string}
 */
function normalizeTenantId(id) {
    return String(id).replace(/^tenant_/, '');
}

/**
 * 获取租户的日期目录路径
 * @param {string|number} tenantId
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string}
 */
function getTenantDayDir(tenantId, dateStr) {
    return join(SAMPLES_DIR, normalizeTenantId(tenantId), dateStr);
}

/**
 * 保存采样数据到文件
 * @param {string|number} tenantId - 租户ID（数字或 'tenant_X' 格式）
 * @param {string} dateStr - YYYY-MM-DD
 * @param {object} data - 采样数据
 * @returns {Promise<{filePath: string, relativePath: string}>}
 */
export async function saveSample(tenantId, dateStr, data) {
    const dir = getTenantDayDir(tenantId, dateStr);
    ensureDir(dir);

    const timestamp = Math.floor(Date.now() / 1000);
    const hash = randomBytes(3).toString('hex');
    const filename = `${timestamp}_${hash}.json`;
    const filePath = join(dir, filename);

    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

    // 相对路径用于数据库存储
    const normalizedId = normalizeTenantId(tenantId);
    const relativePath = `${normalizedId}/${dateStr}/${filename}`;

    return {filePath, relativePath};
}

/**
 * 读取某个租户某个周期的所有采样文件
 * @param {string|number} tenantId
 * @param {string} period - YYYY-MM
 * @returns {Promise<object[]>}
 */
export async function getSamples(tenantId, period) {
    const tenantDir = join(SAMPLES_DIR, normalizeTenantId(tenantId));
    if (!existsSync(tenantDir)) return [];

    const samples = [];
    try {
        const dateDirs = readdirSync(tenantDir);
        for (const dateDir of dateDirs) {
            if (!dateDir.startsWith(period)) continue;
            const dayDir = join(tenantDir, dateDir);
            if (!statSync(dayDir).isDirectory()) continue;
            const files = readdirSync(dayDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = readFileSync(join(dayDir, file), 'utf8');
                    const data = JSON.parse(content);
                    data._fileName = file;
                    data._dateDir = dateDir;
                    samples.push(data);
                } catch (e) {
                    // 跳过损坏的文件
                    logger.warn(`Failed to read sample file: ${dayDir}/${file}: ${e.message}`);
                }
            }
        }
    } catch (e) {
        logger.error(`Failed to read samples for tenant ${tenantId}: ${e.message}`);
    }

    return samples;
}

/**
 * 获取某个租户某个周期的采样数量
 * @param {string|number} tenantId
 * @param {string} period - YYYY-MM
 * @returns {Promise<number>}
 */
export async function getSampleCount(tenantId, period) {
    const samples = await getSamples(tenantId, period);
    return samples.length;
}

/**
 * 清理过期采样文件
 * @param {number} retentionDays - 保留天数，默认30
 * @returns {Promise<number>} 清理的文件数
 */
export async function cleanupOldSamples(retentionDays = 30) {
    if (!existsSync(SAMPLES_DIR)) return 0;

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    try {
        const tenantDirs = readdirSync(SAMPLES_DIR);
        for (const tenantDir of tenantDirs) {
            const tenantPath = join(SAMPLES_DIR, tenantDir);
            if (!statSync(tenantPath).isDirectory()) continue;

            const dateDirs = readdirSync(tenantPath);
            for (const dateDir of dateDirs) {
                const dayPath = join(tenantPath, dateDir);
                if (!statSync(dayPath).isDirectory()) continue;

                const files = readdirSync(dayPath);
                let allOld = true;
                for (const file of files) {
                    const filePath = join(dayPath, file);
                    try {
                        const stats = statSync(filePath);
                        if (stats.mtimeMs < cutoff) {
                            unlinkSync(filePath);
                            deletedCount++;
                        } else {
                            allOld = false;
                        }
                    } catch {
                        // 文件可能已被删除
                    }
                }

                // 如果目录为空则删除
                if (allOld) {
                    try {
                        const remaining = readdirSync(dayPath);
                        if (remaining.length === 0) {
                            rmdirSync(dayPath);
                        }
                    } catch {
                        // 忽略删除目录失败
                    }
                }
            }
        }
    } catch (e) {
        logger.error(`Failed to cleanup old samples: ${e.message}`);
    }

    if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} old sample files`);
    }

    return deletedCount;
}

/**
 * 获取采样目录总大小（字节）
 * @returns {number}
 */
export function getTotalSize() {
    if (!existsSync(SAMPLES_DIR)) return 0;
    let total = 0;
    try {
        const walk = (dir) => {
            const entries = readdirSync(dir);
            for (const entry of entries) {
                const full = join(dir, entry);
                const stats = statSync(full);
                if (stats.isDirectory()) {
                    walk(full);
                } else {
                    total += stats.size;
                }
            }
        };
        walk(SAMPLES_DIR);
    } catch {
        // ignore
    }
    return total;
}