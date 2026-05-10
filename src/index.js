#!/usr/bin/env node

/**
 * 应用入口
 * @module index
 */

import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';
import {networkInterfaces} from 'os';
import {createServer} from './server.js';
import {authenticateGitHub, isAuthenticated, refreshCopilotToken} from './services/copilot/auth.js';
import {credentialStore} from './services/codebuddy/credential-store.js';
import {relayStore} from './services/relay/relay-store.js';
import logger from './utils/logger.js';

// 加载 .env 配置文件
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envFile = join(__dirname, '..', '.env');

try {
    const envContent = readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach((line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;

        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
            let value = valueParts.join('=').trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
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
 * 初始化 Copilot 服务（后台异步，不阻塞主进程）
 */
function initializeCopilot() {
    if (!AUTO_AUTH) {
        return;
    }

    (async () => {
        if (!isAuthenticated()) {
            console.log('\n========================================');
            console.log('GitHub Copilot Authentication');
            console.log('========================================\n');
            console.log('Authenticating in background...\n');

            try {
                const {userInfo} = await authenticateGitHub();
                console.log(`\n✓ GitHub token written to .copilot/github_token`);
                console.log(`✓ Successfully authenticated as ${userInfo.login}\n`);

                await refreshCopilotToken();
                console.log('✓ Copilot token refreshed\n');
            } catch (error) {
                console.error('✗ Copilot authentication failed:', error.message);
                console.log('  The server is still running, but Copilot proxy will not work.');
                console.log('  Please check your credentials and restart the service.\n');
            }
        } else {
            logger.info('Already authenticated, skipping GitHub authentication');

            try {
                await refreshCopilotToken();
                logger.info('Copilot token refreshed');
            } catch (error) {
                logger.warn('Failed to refresh Copilot token on startup:', error.message);
            }
        }
    })();
}

/**
 * 初始化 CodeBuddy 服务
 */
function initializeCodebuddy() {
    const apiInfo = credentialStore.getApiKeyInfo();
    logger.info(`✓ CodeBuddy API Key: ${apiInfo.prefix}`);

    const hasCredentials = credentialStore.hasCredentials();
    if (hasCredentials) {
        const tm = credentialStore.getTokenManager();
        const info = tm.getCurrentCredentialInfo();
        logger.info(`✓ Found ${tm.credentials.length} CodeBuddy credential(s)`);
        logger.info(`✓ Current credential: ${info.filename || 'N/A'} (${info.userId || 'unknown'})`);
        logger.info(`✓ Auto rotation: ${tm.autoRotationEnabled ? 'enabled' : 'disabled'}`);
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
    if (apiInfo.prefix) {
        logger.info(`Relay API Key: ${apiInfo.prefix}`);
    }
    logger.info('  Visit /relayFE to configure upstreams');
}

// 初始化并启动服务
(async () => {
    try {
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
            console.log(`✓ Health check endpoint: http://${localIp}:${PORT}/health`);
            console.log(`✓ Copilot proxy endpoint: http://${localIp}:${PORT}/copilot`);
            console.log(`✓ CodeBuddy proxy endpoint: http://${localIp}:${PORT}/codebuddy`);
            console.log(`✓ CodeBuddy admin UI: http://${localIp}:${PORT}/codebuddyFE`);
            console.log(`✓ Relay proxy endpoint: http://${localIp}:${PORT}/relay`);
            console.log(`✓ Relay admin UI: http://${localIp}:${PORT}/relayFE\n`);
        });

        // 优雅关闭
        const shutdown = (signal) => {
            console.log(`\n${signal} received, shutting down gracefully...`);
            credentialStore.flushApiCallCounts();
            relayStore.flushApiCallCounts();
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
