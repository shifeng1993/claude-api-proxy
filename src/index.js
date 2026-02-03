/**
 * 应用入口
 * @module index
 */

import {createServer} from './server.js';

// 配置
const PORT = parseInt(process.env.PORT, 10) || 3080;
const HOST = process.env.HOST || '0.0.0.0';

// 创建并启动服务器
const server = createServer();

server.listen(PORT, HOST, () => {
    console.log(`Claude API Proxy server running at http://${HOST}:${PORT}`);
    console.log(`Health check endpoint: http://${HOST}:${PORT}/health`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
