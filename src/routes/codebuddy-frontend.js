/**
 * CodeBuddy 前端管理界面路由
 * 提供 Web UI 用于 OAuth2 认证和凭证管理
 * 支持登录鉴权模式 - 单租户
 * @module routes/codebuddy-frontend
 */

import {randomUUID, randomBytes} from 'crypto';
import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import logger from '../utils/logger.js';
import {credentialStore} from '../services/codebuddy/credential-store.js';
import {getCodebuddyBaseUrl, DEFAULT_BASE_URL} from '../services/codebuddy/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatesDir = join(__dirname, '..', 'templates');

function readTemplate(name) {
    return readFileSync(join(templatesDir, name), 'utf8');
}

// 认证状态存储 (简化版，生产环境应使用 Redis 等)
const authStates = new Map();
const AUTH_STATE_TTL = 30 * 60 * 1000; // 30 分钟过期

/**
 * 清理过期的认证状态，防止内存泄漏
 */
function cleanupExpiredAuthStates() {
    const now = Date.now();
    for (const [key, value] of authStates.entries()) {
        if (now - value.createdAt > AUTH_STATE_TTL) {
            authStates.delete(key);
        }
    }
}

// 每 10 分钟清理一次过期认证状态
setInterval(cleanupExpiredAuthStates, 10 * 60 * 1000).unref();

// CodeBuddy OAuth2 端点（根据传入 base_url 动态构建）
function getBaseUrl(customUrl) {
    return getCodebuddyBaseUrl(customUrl);
}

function getAuthStateEndpoint(customUrl) {
    return `${getBaseUrl(customUrl)}/v2/plugin/auth/state`;
}

function getAuthTokenEndpoint(customUrl) {
    return `${getBaseUrl(customUrl)}/v2/plugin/auth/token`;
}

/**
 * 生成请求头
 */
function getAuthStartHeaders(customUrl) {
    const requestId = randomUUID().replace(/-/g, '');
    const baseUrl = getBaseUrl(customUrl);
    const host = new URL(baseUrl).host;
    return {
        Host: host,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': host,
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
        'X-Product': 'SaaS',
        'X-Request-ID': requestId
    };
}

function getAuthPollHeaders(customUrl) {
    const requestId = randomUUID().replace(/-/g, '');
    const spanId = randomBytes(8).toString('hex');
    const baseUrl = getBaseUrl(customUrl);
    const host = new URL(baseUrl).host;
    return {
        Host: host,
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Request-ID': requestId,
        b3: `${requestId}-${spanId}-1-`,
        'X-B3-TraceId': requestId,
        'X-B3-ParentSpanId': '',
        'X-B3-SpanId': spanId,
        'X-B3-Sampled': '1',
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-No-Enterprise-Id': 'true',
        'X-No-Department-Info': 'true',
        'X-Domain': host,
        'User-Agent': 'CLI/1.0.8 CodeBuddy/1.0.8',
        'X-Product': 'SaaS'
    };
}

/**
 * 发送 JSON 响应
 */
function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

/**
 * 获取状态信息（替代 handleMyTenant）
 */
function handleStatus(req, res) {
    const tm = credentialStore.getTokenManager();
    const apiInfo = credentialStore.getApiKeyInfo();
    const usage = credentialStore.getUsageStats();
    sendJson(res, 200, {
        hasCredentials: tm.hasCredentials(),
        credentialCount: tm.credentials?.length || 0,
        apiKeyPrefix: apiInfo.prefix,
        apiKeyPlain: apiInfo.apiKeyPlain,
        autoRotationEnabled: tm.autoRotationEnabled,
        rotationCount: tm.rotationCount,
        manualSelectedIndex: tm.manualSelectedIndex,
        usage
    });
}

/**
 * GET/POST 轮换配置
 */
function handleRotationConfig(req, res, method) {
    const manager = credentialStore.getTokenManager();
    if (method === 'GET') {
        return sendJson(res, 200, {
            autoRotationEnabled: manager.autoRotationEnabled,
            rotationCount: manager.rotationCount
        });
    }
    // POST: 更新配置
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        try {
            const body = Buffer.concat(chunks).toString('utf8');
            const data = JSON.parse(body);
            if (data.autoRotationEnabled !== undefined) {
                manager.setAutoRotation(data.autoRotationEnabled);
                if (!data.autoRotationEnabled && manager.manualSelectedIndex === null) {
                    manager.setManualCredential(manager.currentIndex);
                } else if (data.autoRotationEnabled) {
                    manager.clearManualSelection();
                }
            }
            if (data.rotationCount !== undefined) {
                manager.setRotationCount(data.rotationCount);
            }
            sendJson(res, 200, {
                autoRotationEnabled: manager.autoRotationEnabled,
                rotationCount: manager.rotationCount,
                manualSelectedIndex: manager.manualSelectedIndex
            });
        } catch (error) {
            sendJson(res, 500, {error: error.message});
        }
    });
}

/**
 * 重新生成 API Key
 */
function handleRegenerateApiKey(req, res) {
    try {
        const apiKey = credentialStore.regenerateApiKey();
        if (apiKey) {
            sendJson(res, 200, {
                message: 'API Key 已重新生成，新 Key 仅显示一次！',
                api_key: apiKey
            });
        } else {
            sendJson(res, 400, {error: '重新生成失败'});
        }
    } catch (error) {
        logger.error('重新生成 API Key 失败:', error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * 凭证操作（list/delete/select/auto/toggle-rotation/toggle-disable）
 */
function handleCredentials(req, res, action) {
    const manager = credentialStore.getTokenManager();

    try {
        switch (action) {
            case 'list': {
                const credentials = manager.getCredentialsInfo();
                sendJson(res, 200, {credentials});
                break;
            }
            case 'delete': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        if (index === undefined || index === null) {
                            sendJson(res, 400, {error: 'index is required'});
                            return;
                        }
                        const success = manager.deleteCredential(index);
                        if (success) {
                            sendJson(res, 200, {message: '凭证删除成功'});
                        } else {
                            sendJson(res, 400, {error: '删除失败，无效的索引'});
                        }
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'select': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        const success = manager.setManualCredential(index);
                        if (success) {
                            sendJson(res, 200, {message: `凭证 #${index + 1} 已手动选择`});
                        } else {
                            sendJson(res, 400, {error: '无效的索引'});
                        }
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            case 'auto': {
                manager.clearManualSelection();
                sendJson(res, 200, {message: '已恢复自动轮换'});
                break;
            }
            case 'toggle-rotation': {
                const isEnabled = manager.toggleAutoRotation();
                sendJson(res, 200, {
                    message: `自动轮换已${isEnabled ? '启用' : '禁用'}`,
                    auto_rotation_enabled: isEnabled
                });
                break;
            }
            case 'toggle-disable': {
                const chunks = [];
                req.on('data', (chunk) => chunks.push(chunk));
                req.on('end', () => {
                    try {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const data = JSON.parse(body);
                        const {index} = data;
                        if (index === undefined || index === null) {
                            sendJson(res, 400, {error: 'index is required'});
                            return;
                        }
                        const result = manager.toggleCredentialDisable(index);
                        sendJson(res, 200, {
                            message: `凭证 #${index + 1} 已${result.disabled ? '禁用' : '启用'}`,
                            disabled: result.disabled
                        });
                    } catch (error) {
                        sendJson(res, 500, {error: error.message});
                    }
                });
                break;
            }
            default:
                sendJson(res, 400, {error: 'Unknown action'});
        }
    } catch (error) {
        logger.error(`凭证操作失败 (${action}):`, error);
        sendJson(res, 500, {error: error.message});
    }
}

/**
 * OAuth2 认证启动
 */
async function handleAuthStart(req, res) {
    try {
        // 从查询参数读取 base_url
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const baseUrl = urlObj.searchParams.get('base_url') || DEFAULT_BASE_URL;

        logger.info(`启动 CodeBuddy OAuth2 认证流程 (base_url: ${baseUrl})...`);

        const nonce = randomBytes(8).toString('hex');

        const stateUrl = `${getAuthStateEndpoint(baseUrl)}?platform=CLI&nonce=${nonce}`;
        const payload = JSON.stringify({nonce});

        const response = await fetch(stateUrl, {
            method: 'POST',
            headers: getAuthStartHeaders(baseUrl),
            body: payload
        });

        if (!response.ok) {
            throw new Error(`Auth state endpoint returned ${response.status}`);
        }

        const result = await response.json();

        if (result.code === 0 && result.data) {
            const {state, authUrl} = result.data;

            if (state && authUrl) {
                // 存储认证状态，标记 base_url
                authStates.set(state, {
                    createdAt: Date.now(),
                    status: 'pending',
                    baseUrl: baseUrl
                });

                logger.info(`认证流程启动成功, state: ${state.slice(0, 16)}...`);

                return sendJson(res, 200, {
                    success: true,
                    auth_state: state,
                    verification_uri_complete: authUrl,
                    verification_uri: getBaseUrl(baseUrl),
                    expires_in: 1800,
                    interval: 5,
                    status: 'awaiting_login',
                    message: '请使用提供的链接登录 CodeBuddy'
                });
            }
        }

        throw new Error('Invalid response from auth state endpoint');
    } catch (error) {
        logger.error('启动认证失败:', error);

        const isTlsError =
            error.message &&
            (error.message.includes('CA certificate key too weak') ||
                error.message.includes('unable to verify') ||
                error.message.includes('certificate') ||
                error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                error.code === 'CERT_HAS_EXPIRED');

        if (isTlsError) {
            sendJson(res, 500, {
                success: false,
                error: 'tls_error',
                message: 'TLS 证书验证失败: ' + error.message,
                hint: '可以尝试设置环境变量 NODE_TLS_REJECT_UNAUTHORIZED=0 来跳过证书验证（仅用于开发测试）'
            });
        } else {
            sendJson(res, 500, {
                success: false,
                error: 'auth_start_failed',
                message: error.message
            });
        }
    }
}

/**
 * OAuth2 轮询
 */
async function handleAuthPoll(req, res) {
    try {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const data = JSON.parse(body);
        const {auth_state} = data;

        if (!auth_state) {
            return sendJson(res, 400, {
                error: 'missing_parameters',
                error_description: '缺少必要参数: auth_state'
            });
        }

        const authStateRecord = authStates.get(auth_state);
        const pollBaseUrl = authStateRecord?.baseUrl || DEFAULT_BASE_URL;
        const url = `${getAuthTokenEndpoint(pollBaseUrl)}?state=${auth_state}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: getAuthPollHeaders(pollBaseUrl)
        });

        if (!response.ok) {
            throw new Error(`Token endpoint returned ${response.status}`);
        }

        const result = await response.json();

        if (result.code === 11217) {
            return sendJson(res, 200, {
                status: 'pending',
                message: result.msg || '等待用户登录...',
                code: result.code
            });
        } else if (result.code === 0 && result.data?.accessToken) {
            const tokenData = result.data;

            let userId = 'unknown';
            let userInfo = {};

            try {
                const bearerToken = tokenData.accessToken;
                if (bearerToken && bearerToken.includes('.')) {
                    const parts = bearerToken.split('.');
                    if (parts.length >= 2) {
                        let payloadPart = parts[1];
                        const missingPadding = payloadPart.length % 4;
                        if (missingPadding) {
                            payloadPart += '='.repeat(4 - missingPadding);
                        }
                        const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));

                        userId = payload.email || payload.preferred_username || payload.sub || 'unknown';
                        userInfo = {
                            sub: payload.sub,
                            email: payload.email,
                            preferred_username: payload.preferred_username,
                            name: payload.name,
                            scope: payload.scope,
                            session_state: payload.sid
                        };
                        Object.keys(userInfo).forEach((key) => {
                            if (userInfo[key] === undefined) delete userInfo[key];
                        });

                        // 企业版检测：从 JWT iss 字段提取 enterpriseId
                        // 官方逻辑：iss 格式为 https://xxx/auth/realms/sso-{enterpriseId}
                        // 个人版 iss 不含 sso- 前缀
                        if (payload.iss) {
                            const lastItem = payload.iss.split('/').pop();
                            if (lastItem && lastItem.startsWith('sso-')) {
                                userInfo.enterprise_id = lastItem.slice(4);
                            }
                        }
                    }
                }
            } catch (e) {
                logger.warn('JWT 解析失败:', e.message);
            }

            // 企业版：获取完整 account 信息（含 departmentFullName、enterpriseName）
            let accountInfo = {};
            if (userInfo.enterprise_id) {
                try {
                    const accountUrl = `${getBaseUrl(pollBaseUrl)}/v2/plugin/login/account?state=${auth_state}`;
                    const accountHost = new URL(getBaseUrl(pollBaseUrl)).host;
                    const accountResp = await fetch(accountUrl, {
                        method: 'GET',
                        headers: {
                            Host: accountHost,
                            Accept: 'application/json',
                            Authorization: `Bearer ${tokenData.accessToken}`,
                            'X-Domain': tokenData.domain || accountHost,
                            'X-No-User-Id': 'true',
                            'X-No-Enterprise-Id': 'true',
                            'X-No-Department-Info': 'true',
                            'X-Requested-With': 'XMLHttpRequest',
                            'User-Agent': `CLI/1.0.8 CodeBuddy/1.0.8`
                        }
                    });
                    if (accountResp.ok) {
                        const accountResult = await accountResp.json();
                        if (accountResult.code === 0 && accountResult.data) {
                            accountInfo = accountResult.data;
                            logger.info(`获取企业 account 信息成功: enterpriseId=${accountInfo.enterpriseId || userInfo.enterprise_id}`);
                        }
                    }
                } catch (e) {
                    logger.warn('获取企业 account 信息失败:', e.message);
                }
            }

            const credentialData = {
                bearer_token: tokenData.accessToken,
                user_id: userId,
                base_url: pollBaseUrl,
                created_at: Math.floor(Date.now() / 1000),
                expires_in: tokenData.expiresIn,
                refresh_token: tokenData.refreshToken,
                token_type: tokenData.tokenType || 'Bearer',
                scope: tokenData.scope,
                domain: tokenData.domain,
                session_state: tokenData.sessionState,
                enterprise_id: accountInfo.enterpriseId || userInfo.enterprise_id || '',
                enterprise_name: accountInfo.enterpriseName || '',
                department_info: accountInfo.departmentFullName || '',
                user_info: userInfo,
                account_info: accountInfo,
                full_response: result
            };

            const filename = `codebuddy_${userId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20)}_${Date.now()}.json`;

            // 保存到 credentialStore's token manager
            const tm = credentialStore.getTokenManager();
            const saved = tm.addCredentialWithData(credentialData, filename);

            if (saved) {
                logger.info(`认证成功，用户: ${userId}`);
            } else {
                logger.error('凭证保存失败');
            }

            authStates.delete(auth_state);

            return sendJson(res, 200, {
                status: 'success',
                message: '认证成功！',
                saved,
                user_info: {
                    user_id: userId,
                    email: userInfo.email,
                    name: userInfo.name
                }
            });
        } else {
            return sendJson(res, 400, {
                status: 'error',
                message: result.msg || '认证失败',
                code: result.code
            });
        }
    } catch (error) {
        logger.error('轮询认证状态失败:', error);
        sendJson(res, 500, {
            status: 'error',
            message: error.message
        });
    }
}

/**
 * 管理面板 HTML
 */
function serveAdminPage(res) {
    let html = readTemplate('codebuddy-admin.html');
    html = html.replaceAll('{{displayName}}', '管理员');
    html = html.replaceAll('{{logoutButton}}', '');
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(html);
}


/**
 * 主路由处理函数
 */
export async function routeCodebuddyFrontend(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    // ========== 主页面 ==========
    if (pathname === '/codebuddyFE' || pathname === '/codebuddyFE/') {
        return serveAdminPage(res);
    }

    // 获取状态
    if (pathname === '/codebuddyFE/status' && method === 'GET') {
        return handleStatus(req, res);
    }

    // OAuth2 轮询（必须在其他路由之前）
    if (pathname === '/codebuddyFE/auth/poll' && method === 'POST') {
        return handleAuthPoll(req, res);
    }

    // 凭证操作
    if (pathname === '/codebuddyFE/credentials' && method === 'GET') {
        return handleCredentials(req, res, 'list');
    }
    if (pathname === '/codebuddyFE/credentials/delete' && method === 'POST') {
        return handleCredentials(req, res, 'delete');
    }
    if (pathname === '/codebuddyFE/credentials/select' && method === 'POST') {
        return handleCredentials(req, res, 'select');
    }
    if (pathname === '/codebuddyFE/credentials/auto' && method === 'POST') {
        return handleCredentials(req, res, 'auto');
    }
    if (pathname === '/codebuddyFE/credentials/toggle-rotation' && method === 'POST') {
        return handleCredentials(req, res, 'toggle-rotation');
    }
    if (pathname === '/codebuddyFE/credentials/toggle-disable' && method === 'POST') {
        return handleCredentials(req, res, 'toggle-disable');
    }

    // 轮换配置
    if (pathname === '/codebuddyFE/rotation/config') {
        return handleRotationConfig(req, res, method);
    }

    // 认证启动
    if (pathname === '/codebuddyFE/auth/start' && method === 'GET') {
        return handleAuthStart(req, res);
    }

    // 刷新统计数据
    if (pathname === '/codebuddyFE/stats/refresh' && method === 'POST') {
        credentialStore.flushApiCallCounts();
        return sendJson(res, 200, {message: '数据已刷新'});
    }

    // 重置自定义统计数据
    if (pathname === '/codebuddyFE/stats/custom-reset' && method === 'POST') {
        credentialStore.resetCustomStats();
        return sendJson(res, 200, {message: '自定义统计数据已重置'});
    }

    // 获取每日使用数据
    if (pathname === '/codebuddyFE/stats/daily' && method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const month = urlObj.searchParams.get('month') || '';
        if (!month) {
            return sendJson(res, 400, {error: '缺少 month 参数'});
        }
        const dailyData = credentialStore.getDailyUsage(month);
        return sendJson(res, 200, {month, data: dailyData});
    }

    // 重新生成 API Key
    if (pathname === '/codebuddyFE/regenerate-key' && method === 'POST') {
        return handleRegenerateApiKey(req, res);
    }

    // 404
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: 'Not found'}));
}
