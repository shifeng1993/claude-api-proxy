import { NodeSSH } from 'node-ssh';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const CONFIG = {
  host: process.env.DEPLOY_HOST || 'deploy.example.com',
  port: parseInt(process.env.DEPLOY_PORT || '22', 10),
  username: process.env.DEPLOY_USER || 'deploy',
  remotePath: process.env.DEPLOY_PATH || '/home/claude-api-proxy',
  pm2Name: process.env.DEPLOY_PM2_NAME || 'ClaudeApiProxy',
  healthUrl: process.env.DEPLOY_HEALTH_URL || 'http://localhost:3080/health',
};

async function getPassword() {
  // 1. 命令行参数 --password=xxx
  const arg = process.argv.find(a => a.startsWith('--password='));
  if (arg) return arg.split('=').slice(1).join('=');

  // 2. 环境变量 DEPLOY_PASSWORD
  if (process.env.DEPLOY_PASSWORD) return process.env.DEPLOY_PASSWORD;

  // 3. 交互式输入
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Enter SSH password for ${CONFIG.username}@${CONFIG.host}: `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const UPLOAD_DIRS = ['src'];
const UPLOAD_FILES = ['ecosystem.config.cjs', 'package.json', 'package-lock.json'];
const EXCLUDE_PATTERNS = [/node_modules/, /\.codebuddy/, /\.relay/, /\.git/, /\.env$/];

function shouldExclude(filePath) {
  return EXCLUDE_PATTERNS.some(p => p.test(filePath));
}

async function deploy() {
  const ssh = new NodeSSH();
  const password = await getPassword();
  if (!password) {
    console.error('Password is required. Use --password=xxx, DEPLOY_PASSWORD env, or interactive input.');
    process.exit(1);
  }

  console.log('Connecting to server...');
  await ssh.connect({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    password,
  });
  console.log('Connected.');

  try {
    // Upload directories
    for (const dir of UPLOAD_DIRS) {
      const localDir = path.join(PROJECT_ROOT, dir);
      if (!fs.existsSync(localDir)) {
        console.log(`Skipping ${dir}/ (not found)`);
        continue;
      }
      console.log(`Uploading ${dir}/ ...`);
      await ssh.putDirectory(localDir, `${CONFIG.remotePath}/${dir}`, {
        recursive: true,
        validate: (itemPath) => !shouldExclude(itemPath),
        tick: (localPath, remotePath, error) => {
          if (error) {
            console.error(`  Failed: ${localPath} -> ${remotePath}`, error.message);
          }
        },
      });
      console.log(`  ${dir}/ uploaded.`);
    }

    // Upload files
    for (const file of UPLOAD_FILES) {
      const localFile = path.join(PROJECT_ROOT, file);
      if (!fs.existsSync(localFile)) {
        console.log(`Skipping ${file} (not found)`);
        continue;
      }
      console.log(`Uploading ${file} ...`);
      await ssh.putFile(localFile, `${CONFIG.remotePath}/${file}`);
      console.log(`  ${file} uploaded.`);
    }

    // Install dependencies and restart
    console.log('Installing dependencies and restarting...');
    const result = await ssh.execCommand(
      `cd ${CONFIG.remotePath} && npm install --omit=dev && pm2 startOrRestart ecosystem.config.cjs --env production && pm2 save`,
    );
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.code !== 0) {
      throw new Error(`Remote command failed with exit code ${result.code}`);
    }

    // Health check (retry until service is ready)
    console.log('Running health check...');
    let healthData = null;
    for (let i = 0; i < 10; i++) {
      const health = await ssh.execCommand(`curl -sf ${CONFIG.healthUrl} 2>/dev/null || true`);
      if (health.stdout) {
        try {
          healthData = JSON.parse(health.stdout);
          break;
        } catch { /* not ready yet, retry */ }
      }
      console.log(`  Waiting for service... (${i + 1}/10)`);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Show PM2 status
    const pm2 = await ssh.execCommand(`pm2 status`);

    console.log('\n========== Deployment Result ==========');
    console.log(pm2.stdout);
    console.log(`Health: ${healthData?.status === 'ok' ? 'OK' : 'FAILED'}`);
    if (healthData?.timestamp) console.log(`Timestamp: ${healthData.timestamp}`);
    console.log('=======================================');
  } finally {
    ssh.dispose();
  }
}

deploy().catch((err) => {
  console.error('Deployment failed:', err.message);
  process.exit(1);
});
