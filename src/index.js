#!/usr/bin/env node

/**
 * 应用入口
 * @module index
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {createServer} from './server.js';
import {authenticateGitHub, isAuthenticated, refreshCopilotToken} from './services/copilot/auth.js';
import logger from './utils/logger.js';

// 加载 .env 配置文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envFile = join(__dirname, '..', '.env');

try {
    const envContent = readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
            const value = valueParts.join('=').trim();
            process.env[key.trim()] = value;
        }
    });
    console.log('✓ 已加载 .env 配置');
    if (process.env.HTTP_PROXY) {
        console.log(`✓ HTTP 代理: ${process.env.HTTP_PROXY}`);
    }
} catch (err) {
    console.log('⚠ 未找到 .env 文件，使用默认配置');
}

// 配置
const PORT = parseInt(process.env.PORT, 10) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const AUTO_AUTH = process.env.COPILOT_AUTO_AUTH !== 'false';

/**
 * 初始化 Copilot 服务
 */
async function initializeCopilot() {
    // 如果禁用自动认证，直接返回
    if (!AUTO_AUTH) {
        return;
    }

    // 检查是否已认证
    if (!isAuthenticated()) {
        console.log('\n========================================');
        console.log('🔐 GitHub Copilot Authentication Required');
        console.log('========================================\n');
        
        try {
            const {userInfo} = await authenticateGitHub();
            console.log(`\n✓ GitHub token written to .copilot/github_token`);
            console.log(`✓ Successfully authenticated as ${userInfo.login}\n`);
            
            // 获取初始 Copilot token
            await refreshCopilotToken();
            console.log('✓ Copilot token refreshed\n');
        } catch (error) {
            console.error('✗ Authentication failed:', error.message);
            console.log('\nYou can try again by restarting the service.\n');
            process.exit(1);
        }
    } else {
        logger.info('Already authenticated, skipping GitHub authentication');
        
        // 尝试刷新 Copilot token（如果需要）
        try {
            await refreshCopilotToken();
            logger.info('Copilot token refreshed');
        } catch (error) {
            logger.warn('Failed to refresh Copilot token on startup:', error.message);
        }
    }
}

// 初始化并启动服务
(async () => {
    try {
        // 初始化 Copilot
        await initializeCopilot();
        
        // 创建并启动服务器
        const server = createServer();
        
        server.listen(PORT, HOST, () => {
            console.log(`✓ Server running at http://${HOST}:${PORT}`);
            console.log(`✓ Health check endpoint: http://${HOST}:${PORT}/health`);
            console.log(`✓ Copilot proxy endpoint: http://${HOST}:${PORT}/copilot\n`);
        });
        
        // 优雅关闭
        const shutdown = (signal) => {
            console.log(`\n${signal} received, shutting down gracefully...`);
            server.close(() => {
                console.log('Server closed');
                process.exit(0);
            });
        };
        
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();
