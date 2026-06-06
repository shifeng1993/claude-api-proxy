/**
 * 问题反馈路由
 * 接收前端反馈表单，存数据库 + 异步发邮件
 * @module routes/feedback
 */

import Busboy from 'busboy';
import {tmpdir} from 'os';
import {mkdirSync, createWriteStream, rmSync} from 'fs';
import {basename, join} from 'path';
import logger from '../utils/logger.js';
import {saveFeedback, getFeedbackConfig, repairMojibakeFilename} from '../services/feedback.js';
import {unifiedTenantManager} from '../services/gateway/tenant-manager.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 解析 multipart/form-data
 */
function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const fields = {};
        const files = [];
        const writePromises = [];
        const timestamp = Date.now();
        const tmpDir = join(tmpdir(), `feedback-${timestamp}`);
        let fileIndex = 0;

        const timeout = setTimeout(() => {
            reject(new Error('解析请求超时'));
        }, 30000);

        let busboy;
        try {
            busboy = Busboy({
                headers: req.headers,
                defParamCharset: 'utf8',
                limits: {
                    fileSize: parseInt(process.env.FEEDBACK_ATTACHMENT_MAX_SIZE) || 5 * 1024 * 1024,
                    files: parseInt(process.env.FEEDBACK_MAX_ATTACHMENTS) || 5
                }
            });
        } catch (err) {
            clearTimeout(timeout);
            reject(err);
            return;
        }

        busboy.on('field', (name, val) => {
            fields[name] = val;
        });

        busboy.on('file', (name, stream, info) => {
            const filename = repairMojibakeFilename(info.filename);
            if (!filename) {
                stream.resume();
                return;
            }
            try {
                mkdirSync(tmpDir, {recursive: true});
            } catch (err) {
                stream.resume();
                return;
            }
            const safeName = `${fileIndex++}-${basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'attachment'}`;
            const tmpPath = join(tmpDir, safeName);
            const writeStream = createWriteStream(tmpPath);
            stream.pipe(writeStream);

            const writeDone = new Promise((res) => {
                writeStream.on('close', () => {
                    files.push({path: tmpPath, originalName: filename, safeName});
                    res();
                });
            });
            writePromises.push(writeDone);
        });

        busboy.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        busboy.on('finish', () => {
            clearTimeout(timeout);
            Promise.all(writePromises).then(() => {
                resolve({fields, files, tmpDir});
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        req.pipe(busboy);
    });
}

/**
 * 处理反馈提交
 */
export async function handleFeedback(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname !== '/api/feedback') {
        return false;
    }

    logger.info(`收到反馈请求: ${req.method} ${req.url}`);

    if (req.method !== 'POST') {
        sendJson(res, 405, {error: 'Method not allowed'});
        return true;
    }

    let tmpDir = null;
    try {
        const {fields, files, tmpDir: dir} = await parseMultipart(req);
        tmpDir = dir;

        const {category, description, source} = fields;
        const username = req.sessionUser?.username || fields.username || '';

        // 反馈归属以登录会话为准，避免用户在表单里伪造 username/tenantId。
        let finalTenantId = null;
        if (username) {
            try {
                finalTenantId = await unifiedTenantManager.findTenantByUsername(username) || null;
                if (finalTenantId) {
                    logger.info(`反馈自动补全租户ID: username=${username}, tenantId=${finalTenantId}`);
                }
            } catch (e) {
                logger.warn(`查找租户ID失败: ${e.message}`);
            }
        }

        if (!description || description.trim().length < 5) {
            sendJson(res, 400, {error: '问题描述至少5个字'});
            return true;
        }

        if (description.length > 2000) {
            sendJson(res, 400, {error: '问题描述不能超过2000字'});
            return true;
        }

        const validCategories = ['BUG', '功能建议', '其他'];
        const finalCategory = validCategories.includes(category) ? category : '其他';

        // 存数据库 + 异步发邮件
        const result = await saveFeedback({
            category: finalCategory,
            description: description.trim(),
            source,
            username,
            tenantId: finalTenantId,
            files
        });

        if (result.success) {
            sendJson(res, 200, {message: '反馈提交成功', id: result.id});
        } else {
            sendJson(res, 500, {error: '反馈提交失败'});
        }

        return true;
    } catch (err) {
        logger.error('处理反馈失败:', err);
        sendJson(res, 500, {error: '服务器内部错误'});
        return true;
    } finally {
        // 附件已被 saveFeedback 移到正式目录，清理临时目录
        if (tmpDir) {
            try {
                rmSync(tmpDir, {recursive: true, force: true});
            } catch (err) {
                // 忽略清理失败
            }
        }
    }
}
