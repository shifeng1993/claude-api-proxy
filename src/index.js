#!/usr/bin/env node

/**
 * 应用入口
 * @module index
 */

// .env 必须在所有其他模块之前加载，确保环境变量在 ESM 静态 import 阶段就绪
import './load-env.js';

import {networkInterfaces} from 'os';
import {createServer} from './server.js';
import {
    ensureAdminFromEnv,
    getAuthMode,
    initAuthMode,
    unifiedTenantManager
} from './services/gateway/index.js';
import logger from './utils/logger.js';

// 配置
const PORT = parseInt(process.env.PORT, 10) || 3080;
const HOST = process.env.HOST || '0.0.0.0';

// 获取本机内网 IP 地址
function getLocalIp() {
    for (const interfaces of Object.values(networkInterfaces())) {
        for (const iface of interfaces) {
            if (!iface.internal && iface.family === 'IPv4') {
                return iface.address;
            }
        }
    }
    return null;
}

// 初始化并启动服务
(async () => {
    try {
        // Initialize unified tenant manager (single source of truth)
        await unifiedTenantManager.initialize();
        logger.info(`Unified tenant manager initialized with ${unifiedTenantManager.listTenants().length} tenants`);

        // Initialize auth mode: probe LDAP, fallback to local
        await initAuthMode();
        if (getAuthMode() === 'local') {
            if (!process.env.LOCAL_ADMIN_USER || !process.env.LOCAL_ADMIN_PASSWORD) {
                logger.error('Local auth mode requires LOCAL_ADMIN_USER and LOCAL_ADMIN_PASSWORD env vars');
                process.exit(1);
            }
            await ensureAdminFromEnv();
            await unifiedTenantManager.reloadRegistry();
        }

        // Create and start server
        const server = createServer();

        server.listen(PORT, HOST, () => {
            const localIp = getLocalIp() || 'localhost';
            logger.info(`Server running at http://${localIp}:${PORT}`);
            logger.info(`Admin panel: http://${localIp}:${PORT}/dashboard`);
            logger.info(`Relay:    http://${localIp}:${PORT}/relay`);
            logger.info(`CodeBuddy: http://${localIp}:${PORT}/codebuddy\n`);
        });

        // Graceful shutdown
        const shutdown = async (signal) => {
            logger.info(`\n${signal} received, shutting down gracefully...`);
            await unifiedTenantManager.shutdown();
            server.close(() => {
                logger.info('Server closed');
                process.exit(0);
            });
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (error) {
        logger.error('Failed to start server:', error);
        console.error('Failed to start server:', error);
        process.exit(1);
    }
})();
