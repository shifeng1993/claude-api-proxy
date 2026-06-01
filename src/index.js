#!/usr/bin/env node

/**
 * 应用入口
 * @module index
 */

import './load-env.js';
import {networkInterfaces} from 'os';
import {createServer} from './server.js';
import {isAuthenticated, refreshCopilotToken} from './services/copilot/auth.js';
import {copilotStore} from './services/copilot/copilot-store.js';
import {credentialStore} from './services/codebuddy/credential-store.js';
import {relayStore} from './services/relay/relay-store.js';
import {initGatewayAuth, isAdminAuthEnabled, isGatewayAuthEnabled, getGatewayTokenPrefix} from './services/gateway/auth.js';
import logger from './utils/logger.js';

// 配置
const PORT = parseInt(process.env.PORT, 10) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const AUTO_AUTH = false; // FE-based auth, no console auth

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

/**
 * 初始化 Copilot 服务
 */
function initializeCopilot() {
    const apiInfo = copilotStore.getApiKeyInfo();

    if (isAuthenticated()) {
        (async () => {
            try {
                const proxyUrl = copilotStore.getProxyUrl();
                await refreshCopilotToken(proxyUrl, {
                    rejectUnauthorized: copilotStore.getRejectUnauthorized()
                });
            } catch (error) {
                logger.warn('Failed to refresh Copilot token:', error.message);
            }
        })();
    } else {
        logger.info('Copilot not authenticated');
        logger.info('  Please visit /copilotFE to authenticate with GitHub');
    }
}

/**
 * 初始化 CodeBuddy 服务
 */
function initializeCodebuddy() {
    const apiInfo = credentialStore.getApiKeyInfo();

    const hasCredentials = credentialStore.hasCredentials();
    if (hasCredentials) {
        const tm = credentialStore.getTokenManager();
        const info = tm.getCurrentCredentialInfo();
    } else {
        logger.info('No CodeBuddy credentials found');
        logger.info('  Please add credentials via the admin panel: /codebuddyFE');
    }
}

/**
 * 初始化 Relay 服务
 */
function initializeRelay() {
    const apiInfo = relayStore.getApiKeyInfo();
}

// 初始化并启动服务
(async () => {
    try {
        // 初始化 Gateway 鉴权（必须最早执行，读取环境变量并生成 RSA 密钥对）
        initGatewayAuth();

        // 初始化 Copilot（后台异步，不阻塞）
        initializeCopilot();

        // 初始化 CodeBuddy
        initializeCodebuddy();

        // 初始化 Relay
        initializeRelay();

        // 创建并启动服务器
        const server = createServer();

        server.listen(PORT, HOST, () => {
            const localIp = getLocalIp() || 'localhost';
            console.log(`✓ Server running at http://${localIp}:${PORT}`);
            console.log(`✓ Copilot proxy endpoint: http://${localIp}:${PORT}/copilot`);
            console.log(`✓ Copilot admin UI: http://${localIp}:${PORT}/copilotFE`);
            console.log(`✓ CodeBuddy proxy endpoint: http://${localIp}:${PORT}/codebuddy`);
            console.log(`✓ CodeBuddy admin UI: http://${localIp}:${PORT}/codebuddyFE`);
            console.log(`✓ Relay proxy endpoint: http://${localIp}:${PORT}/relay`);
            console.log(`✓ Relay admin UI: http://${localIp}:${PORT}/relayFE`);

            // 鉴权状态提示
            if (isAdminAuthEnabled()) {
                console.log('✓ Admin panel authentication: enabled');
            } else {
                console.log('⚠ Admin panel authentication: disabled');
            }
            if (isGatewayAuthEnabled()) {
                console.log(`✓ Gateway token authentication: enabled (${getGatewayTokenPrefix()})`);
            } else {
                console.log('⚠ Gateway token authentication: disabled');
            }
            console.log();
        });

        // 优雅关闭
        const shutdown = async (signal) => {
            console.log(`\n${signal} received, shutting down gracefully...`);
            try {
                await Promise.all([
                    credentialStore.flushApiCallCounts(),
                    copilotStore.flushApiCallCounts(),
                    relayStore.flushApiCallCounts()
                ]);
            } catch (err) {
                console.error('Error flushing data during shutdown:', err.message);
            }
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
