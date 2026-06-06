/**
 * .env 配置文件加载器
 * 必须在所有其他模块之前 import，确保环境变量在 ESM 静态 import 阶段就已就绪
 *
 * 加载优先级（高 -> 低）：
 *   1. 进程已有的 process.env（shell export 或 cross-env 设置的，最高优先级）
 *   2. .env.local（本地覆盖文件，不入 git，用于个人开发环境差异）
 *   3. .env（默认配置）
 *
 * 这与 Next.js / Vite 的约定一致：.env.local 用来在不动 .env 的前提下做本地覆盖
 *
 * @module load-env
 */

import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * 读取一个 env 文件并写入 process.env
 * @param {string} filename 项目根目录下的文件名
 * @param {boolean} override 是否覆盖已存在的 env（.env.local 覆盖 .env，但都不覆盖外部 export 的）
 */
function loadEnvFile(filename, override) {
    let envContent;
    try {
        envContent = readFileSync(join(projectRoot, filename), 'utf8');
    } catch {
        return; // 文件不存在，静默跳过
    }

    envContent.split('\n').forEach((line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;

        const [key, ...valueParts] = line.split('=');
        if (!key || valueParts.length === 0) return;

        const normalizedKey = key.trim();
        // override=false: 不覆盖已存在的（.env 的行为）
        // override=true: 覆盖来自其他 env 文件的，但不覆盖外部 export 的
        //   —— 区分方式：只有当前 key 不在 _envFileKeys 中且 process.env 已有值时，才视为外部传入
        if (!override && process.env[normalizedKey] !== undefined) return;
        if (override && process.env[normalizedKey] !== undefined && !_envFileKeys.has(normalizedKey)) return;

        let value = valueParts.join('=').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[normalizedKey] = value;
        _envFileKeys.add(normalizedKey);
    });
}

// 记录由 env 文件设置的 key —— .env.local 只覆盖这些，不动 shell 注入的
const _envFileKeys = new Set();

// 先加载 .env（基础配置）
loadEnvFile('.env', false);

// 再加载 .env.local（本地覆盖，可选）
loadEnvFile('.env.local', true);
