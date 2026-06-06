/**
 * AI使用教练系统总入口
 * 负责初始化定时任务、文件清理、导出便捷函数
 * @module services/coach
 */

import {cleanupOldSamples} from './storage.js';
import {runBatchAnalysis} from './analyzer.js';
import {models} from '../../db/models/index.js';
import logger from '../../utils/logger.js';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天一次
const ANALYSIS_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时检查一次
const RETENTION_DAYS = parseInt(process.env.COACH_RETENTION_DAYS || '30', 10);

class CoachSystem {
    constructor() {
        this._cleanupTimer = null;
        this._analysisTimer = null;
        this._initialized = false;
    }

    /**
     * 初始化教练系统
     */
    async initialize() {
        if (this._initialized) return;

        // 启动定时清理任务（每天凌晨3点左右）
        this._scheduleCleanup();

        // 启动月度分析检查（每小时检查是否到了下月1号）
        this._scheduleAnalysisCheck();

        // 立即执行一次清理
        cleanupOldSamples(RETENTION_DAYS).catch((err) => logger.warn(`Initial sample cleanup failed: ${err.message}`));

        // 初始化默认重点人员
        await this._ensureDefaultKeyPersonnel();

        this._initialized = true;
        logger.info('Coach system initialized');
    }

    /**
     * 确保默认重点人员已标记
     * 默认配置：陆世雄（工号 226862）
     */
    async _ensureDefaultKeyPersonnel() {
        try {
            const defaultPersonnel = [{username: '226862', name: '陆世雄'}];

            for (const person of defaultPersonnel) {
                const updated = await models.Tenant.update(
                    {is_key_personnel: true},
                    {where: {username: person.username}}
                );
                if (updated[0] > 0) {
                    logger.info(`Default key personnel marked: ${person.name} (${person.username})`);

                    // 同步更新内存缓存（codebuddy tenantManager）
                    try {
                        const {tenantManager: cbManager} = await import('../codebuddy/tenant-manager.js');
                        const {tenantManager: relayManager} = await import('../relay/tenant-manager.js');

                        for (const manager of [cbManager, relayManager]) {
                            if (!manager?.registry?.tenants) continue;
                            for (const [key, tenant] of Object.entries(manager.registry.tenants)) {
                                if (tenant.username === person.username) {
                                    tenant.is_key_personnel = true;
                                    break;
                                }
                            }
                        }
                    } catch {
                        // 内存同步失败不影响主流程，重启后自动加载
                    }
                }
            }
        } catch (err) {
            logger.warn(`Failed to ensure default key personnel: ${err.message}`);
        }
    }

    /**
     * 定时清理过期采样文件
     */
    _scheduleCleanup() {
        // 随机偏移分钟数，避免在整点集中执行
        const randomMinute = Math.floor(Math.random() * 60);
        const now = new Date();
        const next3am = new Date(now);
        next3am.setHours(3, randomMinute, 0, 0);
        if (next3am <= now) {
            next3am.setDate(next3am.getDate() + 1);
        }
        const initialDelay = next3am.getTime() - now.getTime();

        this._cleanupTimer = setTimeout(() => {
            cleanupOldSamples(RETENTION_DAYS).catch((err) => logger.warn(`Scheduled cleanup failed: ${err.message}`));
            // 之后每24小时执行一次
            this._cleanupTimer = setInterval(() => {
                cleanupOldSamples(RETENTION_DAYS).catch((err) =>
                    logger.warn(`Scheduled cleanup failed: ${err.message}`)
                );
            }, CLEANUP_INTERVAL_MS).unref();
        }, initialDelay).unref();
    }

    /**
     * 定时检查是否需要执行月度分析（每月1号触发）
     */
    _scheduleAnalysisCheck() {
        this._analysisTimer = setInterval(() => {
            const now = new Date();
            // 每月1号凌晨1点到2点之间触发一次
            if (now.getDate() === 1 && now.getHours() === 1) {
                const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                // 上个月
                const lastMonth = now.getMonth() === 0 ? 12 : now.getMonth();
                const lastMonthYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
                const analysisPeriod = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}`;

                logger.info(`Triggering scheduled monthly analysis for period: ${analysisPeriod}`);
                runBatchAnalysis(analysisPeriod, 'scheduled').catch((err) =>
                    logger.error(`Scheduled analysis failed: ${err.message}`)
                );
            }
        }, ANALYSIS_CHECK_INTERVAL_MS).unref();
    }

    /**
     * 清理定时器
     */
    shutdown() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        if (this._analysisTimer) {
            clearInterval(this._analysisTimer);
            this._analysisTimer = null;
        }
        this._initialized = false;
        logger.info('Coach system shutdown');
    }
}

export const coachSystem = new CoachSystem();

// 便捷导出
export {sampleRequest} from './sampler.js';
export {runAnalysis, runBatchAnalysis} from './analyzer.js';
export {cleanupOldSamples, getSamples, getSampleCount} from './storage.js';
