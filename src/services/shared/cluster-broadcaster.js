/**
 * 多进程集群广播器
 * 在 PM2 fork 模式下，各 worker 进程间通过 HTTP 内部广播同步状态
 * 管理操作（固定路由到首个 worker）完成后，向所有 worker 发送同步通知
 * @module services/shared/cluster-broadcaster
 */

import logger from '../../utils/logger.js';
import {unifiedTenantManager} from '../gateway/tenant-manager.js';

/** 共享密钥，用于内部 API 鉴权，防止外部调用 */
const INTERNAL_SECRET = process.env.CLUSTER_INTERNAL_SECRET || '';
let missingSecretWarned = false;

/** 基础端口号，与 ecosystem.cluster.config.cjs 保持一致 */
const BASE_PORT = parseInt(process.env.CLUSTER_BASE_PORT, 10) || 3081;

/** worker 进程数量，与 ecosystem.cluster.config.cjs 保持一致 */
const WORKER_COUNT = parseInt(process.env.CLUSTER_WORKER_COUNT, 10) || 4;

/** 当前进程监听的端口号 */
const CURRENT_PORT = parseInt(process.env.PORT, 10) || 3080;

/** 广播请求超时时间（毫秒） */
const BROADCAST_TIMEOUT = 3000;

/**
 * 获取所有 worker 的内部同步 URL 列表
 * @param {string} event - 事件名称
 * @returns {string[]}
 */
function getAllSyncUrls(event) {
  const urls = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const port = BASE_PORT + i;
    urls.push(`http://127.0.0.1:${port}/internal/sync`);
  }
  return urls;
}

/**
 * 向所有 worker 进程广播同步通知
 * 不阻塞调用方，异步发送，失败仅记录日志
 * @param {string} event - 事件类型，如 'relay:stats:reset'
 * @param {Object} [data={}] - 事件数据
 */
export function broadcast(event, data = {}) {
  if (!INTERNAL_SECRET) {
    if (!missingSecretWarned) {
      logger.warn('CLUSTER_INTERNAL_SECRET is not configured; cluster sync broadcast is disabled');
      missingSecretWarned = true;
    }
    return;
  }

  const urls = getAllSyncUrls(event);
  const payload = JSON.stringify({event, data});

  for (const url of urls) {
    // 对当前进程走内部处理，不走 HTTP（避免自己给自己发请求）
    const targetPort = parseInt(new URL(url).port, 10);
    if (targetPort === CURRENT_PORT) {
      continue;
    }

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      },
      body: payload,
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT)
    }).then(res => {
      if (!res.ok) {
        logger.warn(`Cluster broadcast failed for ${event} to port ${targetPort}: HTTP ${res.status}`);
      }
    }).catch(err => {
      logger.warn(`Cluster broadcast error for ${event} to port ${targetPort}: ${err.message}`);
    });
  }
}

/**
 * 验证内部同步请求的密钥
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function verifyInternalRequest(req) {
  if (!INTERNAL_SECRET) return false;
  const secret = req.headers['x-internal-secret'];
  return secret === INTERNAL_SECRET;
}

/**
 * 处理内部同步通知
 * 根据事件类型调用对应 manager 的同步方法
 * @param {Object} payload - {event, data}
 */
export async function handleSyncNotification(payload) {
  const {event, data} = payload;

  logger.info(`Cluster sync received: ${event}`, data);

  try {
    switch (event) {
      // ===== Relay 事件 =====
      case 'relay:stats:reset':
        await handleRelayStatsReset(data);
        break;
      case 'relay:stats:refresh':
        await handleRelayStatsRefresh(data);
        break;
      case 'relay:upstream:change':
        await handleRelayUpstreamChange(data);
        break;

      // ===== CodeBuddy 事件 =====
      case 'codebuddy:stats:reset':
        await handleCodebuddyStatsReset(data);
        break;
      case 'codebuddy:stats:refresh':
        await handleCodebuddyStatsRefresh(data);
        break;
      case 'codebuddy:credential:change':
        await handleCodebuddyCredentialChange(data);
        break;

      default:
        logger.warn(`Unknown cluster sync event: ${event}`);
    }
  } catch (error) {
    logger.error(`Cluster sync error for ${event}: ${error.message}`);
  }
}

// ===== Relay 处理函数 =====

async function handleRelayStatsReset(data) {
  await unifiedTenantManager.syncStatsFromDb(data.tenantId, true);
}

async function handleRelayStatsRefresh(data) {
  await unifiedTenantManager.syncStatsFromDb(data.tenantId);
}

async function handleRelayUpstreamChange(data) {
  unifiedTenantManager.invalidateUpstreamCache(data.tenantId);
}

// ===== CodeBuddy 处理函数 =====

async function handleCodebuddyStatsReset(data) {
  await unifiedTenantManager.syncStatsFromDb(data.tenantId, true);
}

async function handleCodebuddyStatsRefresh(data) {
  await unifiedTenantManager.syncStatsFromDb(data.tenantId);
}

async function handleCodebuddyCredentialChange(data) {
  await unifiedTenantManager.reloadCredentialCache(data.tenantId);
}
