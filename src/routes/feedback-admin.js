/**
 * 反馈问题管理路由
 * 提供列表/详情/状态更新/附件下载
 * @module routes/feedback-admin
 */

import {createReadStream, existsSync, rmSync} from 'fs';
import {join} from 'path';
import {Op} from 'sequelize';
import {Feedback} from '../db/models/feedback.js';
import {repairMojibakeFilename} from '../services/feedback.js';
import logger from '../utils/logger.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function canManage(req, feedback) {
    const user = req.sessionUser || {};
    return user.role === 'admin' || (user.username && feedback.username === user.username);
}

function feedbackView(req, feedback) {
    const raw = typeof feedback.toJSON === 'function' ? feedback.toJSON() : feedback;
    return {
        ...raw,
        attachments: (raw.attachments || []).map(item => ({...item, name: repairMojibakeFilename(item.name)})),
        can_manage: canManage(req, raw)
    };
}

export async function routeFeedbackAdmin(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // 渲染管理页面
    if (method === 'GET' && (pathname === '/feedback' || pathname === '/feedback/')) {
        res.writeHead(302, {Location: '/admin#/feedback'});
        res.end();
        return true;
    }

    // 获取问题列表
    if (method === 'GET' && pathname === '/api/feedback/list') {
        const params = Object.fromEntries(url.searchParams);
        const page = parseInt(params.page) || 1;
        const pageSize = parseInt(params.pageSize) || 20;
        const {status, category, keyword} = params;

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

        sendJson(res, 200, {
            total: count,
            page,
            pageSize,
            current_user: req.sessionUser?.username || '',
            is_admin: req.sessionUser?.role === 'admin',
            list: rows.map(row => feedbackView(req, row))
        });
        return true;
    }

    // 更新问题状态
    if (method === 'PUT' && pathname.match(/^\/api\/feedback\/\d+\/status$/)) {
        const id = parseInt(pathname.split('/')[3]);
        const body = await parseBody(req);
        const {status: newStatus, handler, resolveNote} = body;

        if (!['processing', 'resolved'].includes(newStatus)) {
            sendJson(res, 400, {error: '无效的状态值'});
            return true;
        }

        const feedback = await Feedback.findByPk(id);
        if (!feedback) {
            sendJson(res, 404, {error: '反馈不存在'});
            return true;
        }
        if (!canManage(req, feedback)) {
            sendJson(res, 403, {error: '只能修改自己提交的反馈'});
            return true;
        }

        await feedback.update({
            status: newStatus,
            ...(handler ? {handler} : {}),
            ...(resolveNote !== undefined ? {resolve_note: resolveNote} : {})
        });

        sendJson(res, 200, {message: '状态更新成功', feedback});
        return true;
    }

    // 删除反馈
    if (method === 'DELETE' && pathname.match(/^\/api\/feedback\/\d+$/)) {
        const id = parseInt(pathname.split('/')[3]);

        const feedback = await Feedback.findByPk(id);
        if (!feedback) {
            sendJson(res, 404, {error: '反馈不存在'});
            return true;
        }
        if (!canManage(req, feedback)) {
            sendJson(res, 403, {error: '只能删除自己提交的反馈'});
            return true;
        }

        // 删除附件文件
        const attachments = feedback.attachments || [];
        if (attachments.length > 0) {
            const feedbackDir = join(process.env.FEEDBACK_ATTACHMENTS_DIR || 'data/feedback-attachments', String(id));
            try {
                if (existsSync(feedbackDir)) {
                    rmSync(feedbackDir, {recursive: true, force: true});
                }
            } catch (err) {
                logger.warn(`删除反馈附件目录失败: ${feedbackDir}`, err.message);
            }
        }

        await feedback.destroy();
        sendJson(res, 200, {message: '删除成功'});
        return true;
    }

    // 下载附件
    if (method === 'GET' && pathname.match(/^\/api\/feedback\/attachment\/\d+\//)) {
        const parts = pathname.split('/');
        const id = parseInt(parts[4]);
        const filename = decodeURIComponent(parts.slice(5).join('/'));

        const feedback = await Feedback.findByPk(id);
        if (!feedback) {
            sendJson(res, 404, {error: '反馈不存在'});
            return true;
        }

        const attachment = feedback.attachments.find(a => a.name === filename || repairMojibakeFilename(a.name) === filename);
        if (!attachment || !existsSync(attachment.path)) {
            sendJson(res, 404, {error: '附件不存在'});
            return true;
        }

        const stream = createReadStream(attachment.path);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        });
        stream.pipe(res);
        return true;
    }

    return false;
}
