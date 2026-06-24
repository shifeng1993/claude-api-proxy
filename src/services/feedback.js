/**
 * 问题反馈服务
 * 存数据库 + 异步发邮件（邮件失败不影响入库）
 * @module services/feedback
 */

import {execFile} from 'child_process';
import {promisify} from 'util';
import {copyFileSync, unlinkSync, mkdirSync} from 'fs';
import {basename, join} from 'path';
import {Op} from 'sequelize';
import logger from '../utils/logger.js';
import {Feedback} from '../db/models/feedback.js';

const execFileAsync = promisify(execFile);

const ATTACHMENTS_DIR = process.env.FEEDBACK_ATTACHMENTS_DIR || 'data/feedback-attachments';

export function repairMojibakeFilename(filename) {
    if (!filename || typeof filename !== 'string') return filename || '';
    try {
        const decoded = Buffer.from(filename, 'latin1').toString('utf8');
        if (decoded.includes('\uFFFD')) return filename;
        const hasC1Controls = /[\u0080-\u009F]/.test(filename);
        const decodedLooksCjk = /[\u3400-\u9fff]/.test(decoded);
        return (hasC1Controls || decodedLooksCjk) ? decoded : filename;
    } catch {
        return filename;
    }
}

export function canManageFeedback(sessionUser = {}, feedback) {
    return sessionUser.role === 'admin' || (sessionUser.username && feedback?.username === sessionUser.username);
}

export function toFeedbackAdminView(sessionUser, feedback) {
    const raw = typeof feedback.toJSON === 'function' ? feedback.toJSON() : feedback;
    return {
        ...raw,
        attachments: (raw.attachments || []).map(item => ({...item, name: repairMojibakeFilename(item.name)})),
        can_manage: canManageFeedback(sessionUser, raw)
    };
}

export function findFeedbackById(id) {
    return Feedback.findByPk(id);
}

export async function listFeedbackForAdmin({
    page = 1,
    pageSize = 20,
    status,
    category,
    keyword,
    sessionUser = {}
} = {}) {
    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (keyword) {
        where[Op.or] = [
            {description: {[Op.like]: `%${keyword}%`}},
            {username: {[Op.like]: `%${keyword}%`}}
        ];
    }

    const {count, rows} = await Feedback.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: pageSize,
        offset: (page - 1) * pageSize
    });

    return {
        total: count,
        page,
        pageSize,
        current_user: sessionUser.username || '',
        is_admin: sessionUser.role === 'admin',
        list: rows.map(row => toFeedbackAdminView(sessionUser, row))
    };
}

/**
 * 获取反馈配置
 */
function getFeedbackConfig() {
    return {
        mailFrom: process.env.FEEDBACK_MAIL_FROM || '',
        mailTo: (process.env.FEEDBACK_MAIL_TO || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
        attachmentMaxSize: parseInt(process.env.FEEDBACK_ATTACHMENT_MAX_SIZE) || 5 * 1024 * 1024,
        maxAttachments: parseInt(process.env.FEEDBACK_MAX_ATTACHMENTS) || 5
    };
}

/**
 * 通过 mailx 发送反馈邮件（fire-and-forget）
 */
function sendMailAsync({subject, body, attachments = []}) {
    const config = getFeedbackConfig();
    if (config.mailTo.length === 0) return;

    const args = ['-s', subject];
    for (const a of attachments) {
        args.push('-a', a);
    }
    args.push(...config.mailTo);

    execFileAsync('mailx', args, {input: body, timeout: 30000})
        .then(() => logger.info(`反馈邮件已发送: ${subject}`))
        .catch(err => logger.warn(`反馈邮件发送失败(不影响入库): ${err.message}`));
}

/**
 * 保存反馈到数据库 + 异步发邮件
 * @param {Object} options
 * @param {string} options.category
 * @param {string} options.description
 * @param {string} options.source
 * @param {string} options.username
 * @param {string} options.tenantId
 * @param {Array} options.files - [{path, originalName}]
 * @param {string} options.tmpDir - 临时目录路径
 * @returns {Promise<{success: boolean, id?: number, error?: string}>}
 */
export async function saveFeedback({category, description, source, username, tenantId, files = []}) {
    try {
        // 入库
        const feedback = await Feedback.create({
            category,
            description: description.trim(),
            source,
            username,
            tenant_id: tenantId || null,
            status: 'pending',
            attachments: []
        });

        // 移动附件到正式目录
        const attachmentList = [];
        if (files.length > 0) {
            const feedbackDir = join(ATTACHMENTS_DIR, String(feedback.id));
            mkdirSync(feedbackDir, {recursive: true});

            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                const originalName = repairMojibakeFilename(file.originalName);
                const safeName = file.safeName || `${index}-${basename(originalName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'attachment'}`;
                const destPath = join(feedbackDir, safeName);
                try {
                    copyFileSync(file.path, destPath);
                    try { unlinkSync(file.path); } catch {}
                    attachmentList.push({name: originalName, path: destPath});
                } catch (err) {
                    logger.warn(`附件移动失败: ${originalName}`, err.message);
                }
            }

            // 更新附件信息
            if (attachmentList.length > 0) {
                feedback.attachments = attachmentList;
                await feedback.save();
            }
        }

        // 异步发邮件（fire-and-forget）
        const validCategories = ['BUG', '功能建议', '其他'];
        const finalCategory = validCategories.includes(category) ? category : '其他';
        const shortDesc = description.trim().substring(0, 20);
        const subject = `[问题反馈][${finalCategory}] ${shortDesc} - 来自${username || '未知用户'}`;
        const now = new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
        const body = `分类：${finalCategory}\n描述：${description.trim()}\n─────────────────\n提交人：${username || '未知'}\n来源页面：${source === 'relay' ? 'Relay 管理面板' : 'CodeBuddy 管理面板'}\n提交时间：${now}${tenantId ? `\n租户ID：${tenantId}` : ''}`;

        const attachmentPaths = attachmentList.map(a => a.path);
        sendMailAsync({subject, body, attachments: attachmentPaths});

        logger.info(`反馈已入库: #${feedback.id} ${subject}`);
        return {success: true, id: feedback.id};
    } catch (err) {
        logger.error('反馈入库失败:', err.message);
        return {success: false, error: err.message};
    }
}

/**
 * 修复已有的空 tenant_id 记录
 * 根据 username 和 source 反查租户ID
 */
export async function repairEmptyTenantIds({findTenantByUsername} = {}) {
    if (typeof findTenantByUsername !== 'function') return;

    const rows = await Feedback.findAll({
        where: {
            [Op.or]: [
                {tenant_id: null},
                {tenant_id: ''}
            ]
        }
    });

    if (rows.length === 0) return;

    let fixed = 0;
    for (const row of rows) {
        if (!row.username) continue;
        try {
            const tenantId = await findTenantByUsername(row.username);
            if (tenantId) {
                await row.update({tenant_id: tenantId});
                fixed++;
            }
        } catch (e) {
            logger.warn(`修复反馈#${row.id}租户ID失败: ${e.message}`);
        }
    }
    if (fixed > 0) {
        logger.info(`已修复 ${fixed} 条反馈记录的租户ID`);
    }
}

/**
 * 获取反馈配置（供路由层使用）
 */
export {getFeedbackConfig};
