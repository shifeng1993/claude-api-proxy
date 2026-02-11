#!/usr/bin/env node

/**
 * 启动脚本 - 加载.env文件并启动服务
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envFile = join(__dirname, '..', '.env');

// 读取并解析 .env 文件
try {
    const envContent = readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        
        const [key, ...valueParts] = line.split('=');
        if (key &&valueParts.length > 0) {
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

// 动态导入主模块
await import('./index.js');
