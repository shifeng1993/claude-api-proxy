/**
 * CodeBuddy 代码统计转发
 * 把 Claude Code hook 采集到的 code_change_event 透传到 codebuddy 后端 /v2/report。
 * proxy 纯转发不落库；仅当 codebuddy 凭证为企业站时才转发，个人站静默跳过。
 *
 * 两套端点共享同一份 codebuddy 凭证转发逻辑：
 * - /codebuddy/v1/telemetry/* —— codebuddy 直连用户，已由 requireApiAuth 注入 req.tenantId
 * - /relay/v1/telemetry/*    —— relay 用户，req.tenantId 同样指向同一统一租户
 *
 * 当前项目统一租户模型：一个租户一条记录，通过
 * TenantServiceProfile 同时持有 relay 上游与 codebuddy 凭证。因此 relay 用户上报时
 * 直接用其 req.tenantId 取该租户的 codebuddy 凭证即可，无需跨体系按工号关联。
 * 鉴权由 server.js 的 requireApiAuth 中间件统一完成，handler 仅读 req.tenantId。
 * @module services/codebuddy/telemetry-forwarder
 */

import {request as defaultRequest, readBody as defaultReadBody} from '../../utils/http-client.js';
import {
    codebuddyHeaders,
    getCodebuddyBaseUrl,
    isCodebuddyHost,
    isPersonalHost
} from './config.js';
import {getCodebuddyCredentialService} from './credential-service.js';
import {codebuddyUpstreamErrorStatus as defaultUpstreamErrorStatus} from './response-writer.js';

const REPORT_PATH = '/v2/report';
// codebuddy 后端对单个事件字段的最小校验（对齐反编译 buildCodeChangeEvent 的 assert）
const REQUIRED_CODE_CHANGE_FIELDS = ['filePath', 'repoUrl', 'repoBranch'];

function safeHost(baseUrl) {
    try {
        return new URL(baseUrl).host;
    } catch {
        return '';
    }
}

/**
 * 读取并校验请求体，返回事件数组或错误响应。
 * 成功返回 {events}，空数组返回 {events: null, skipped: 'empty_events'}，失败返回 {error}。
 */
async function readAndValidateEvents(req, parseBody) {
    const raw = await parseBody(req);
    let events;
    try {
        events = JSON.parse(raw);
    } catch {
        return {error: {status: 400, message: 'Invalid JSON body', type: 'invalid_request_error'}};
    }
    if (!Array.isArray(events)) events = [events];
    if (events.length === 0) {
        return {events: null, skipped: 'empty_events'};
    }

    // 最小校验：code_change_event 必填字段
    for (const event of events) {
        if (event?.eventCode !== 'code_change_event') continue;
        for (const key of REQUIRED_CODE_CHANGE_FIELDS) {
            if (!event[key]) {
                return {error: {status: 400, message: `Missing field: ${key}`, type: 'invalid_request_error'}};
            }
        }
        if (!Number.isFinite(Number(event.lineCount)) || Number(event.lineCount) < 0) {
            return {error: {status: 400, message: 'Invalid lineCount', type: 'invalid_request_error'}};
        }
        if (!Number.isFinite(Number(event.characterCount)) || Number(event.characterCount) < 0) {
            return {error: {status: 400, message: 'Invalid characterCount', type: 'invalid_request_error'}};
        }
    }
    return {events};
}

/**
 * 创建 codebuddy 代码统计转发 handler 集合。
 *
 * @param {Object} deps
 * @param {Object} deps.tenantManager - tenant manager，relay source-check 用其取活跃上游
 * @param {Object} deps.credentialService - CodebuddyCredentialService，取租户 codebuddy 凭证列表
 * @param {Function} deps.resolveCredential - (headers, credentials, activeIndex) => credential|null
 * @param {Function} deps.getCodebuddyBaseUrl
 * @param {Function} deps.isPersonalHost
 * @param {Function} deps.isCodebuddyHost
 * @param {Function} deps.sendJson
 * @param {Function} deps.sendOpenAIError
 * @param {Function} deps.upstreamErrorStatus
 * @param {Function} deps.parseBody - 同步读请求体为字符串（readCodebuddyRequestBody）
 * @param {Function} deps.request - http-client.request
 * @param {Function} deps.readBody - http-client.readBody
 * @param {Object} deps.logger
 * @returns {{handleTelemetryReport, handleSourceCheck, handleRelayTelemetryReport, handleRelaySourceCheck}}
 */
export function createCodebuddyTelemetryHandlers({
    tenantManager,
    credentialService,
    resolveCredential,
    getCodebuddyBaseUrl,
    isPersonalHost,
    isCodebuddyHost,
    sendJson,
    sendOpenAIError,
    upstreamErrorStatus,
    parseBody,
    request,
    readBody,
    logger
}) {
    if (!tenantManager) throw new Error('createCodebuddyTelemetryHandlers requires tenantManager');
    if (!credentialService) throw new Error('createCodebuddyTelemetryHandlers requires credentialService');
    if (typeof resolveCredential !== 'function') throw new Error('createCodebuddyTelemetryHandlers requires resolveCredential');

    /**
     * 取某租户的活跃 codebuddy 凭证。
     * 成功返回 {credential}，租户无可用凭证返回 {error}（调用方负责发送）。
     */
    async function resolveCodebuddyCredential(req) {
        const tenantId = req.tenantId;
        if (!tenantId) {
            return {error: {status: 503, message: 'CodeBuddy tenant system is not enabled'}};
        }
        const {credentials, activeIndex} = await credentialService.listCredentials(tenantId);
        const credential = resolveCredential(req.headers, credentials, activeIndex);
        if (!credential) {
            return {error: {status: 503, message: 'No available credentials for tenant'}};
        }
        return {credential, tenantId};
    }

    /**
     * 共享转发逻辑：用 codebuddy 凭证把事件透传到 codebuddy /v2/report。
     * codebuddy 直连与 relay 两条链路共用。个人站静默跳过。
     */
    async function forwardToCodebuddy(res, credential, events, tenantInfo) {
        const host = safeHost(getCodebuddyBaseUrl(credential.base_url));

        // 仅企业站转发，个人站静默跳过（hook 不报错、不重试）
        if (isPersonalHost(host)) {
            logger.info(`[CodeBuddy Telemetry] skip personal host: ${tenantInfo}`);
            sendJson(res, 200, {skipped: true, reason: 'personal_host'});
            return;
        }

        const headers = codebuddyHeaders(credential.bearer_token, {
            baseUrl: credential.base_url,
            userId: credential.user_id,
            enterpriseId: credential.enterprise_id,
            departmentInfo: credential.department_info,
            domain: credential.domain
        });
        headers['Content-Type'] = 'application/json; charset=utf-8';

        const url = `${getCodebuddyBaseUrl(credential.base_url)}${REPORT_PATH}`;
        const upstream = await request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(events)
        });

        const upstreamText = await readBody(upstream.body);
        let upstreamJson;
        try {
            upstreamJson = JSON.parse(upstreamText);
        } catch {
            upstreamJson = {raw: upstreamText};
        }

        logger.info(`[CodeBuddy Telemetry] forwarded ${events.length} event(s) to ${host}, status=${upstream.status}`);
        // 原样回吐上游状态码与响应体
        sendJson(res, upstream.status, upstreamJson);
    }

    /**
     * 处理代码统计上报（codebuddy 直连）：/codebuddy/v1/telemetry/report
     */
    async function handleTelemetryReport(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await resolveCodebuddyCredential(req);
            if (authResult.error) {
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }

            const {credential} = authResult;
            tenantInfo = `${credential.user_id || 'unknown'}@${safeHost(getCodebuddyBaseUrl(credential.base_url))}`;

            const {events, skipped, error} = await readAndValidateEvents(req, parseBody);
            if (error) {
                sendOpenAIError(res, error.status, error.message, error.type);
                return;
            }
            if (skipped) {
                sendJson(res, 200, {skipped: true, reason: skipped});
                return;
            }

            await forwardToCodebuddy(res, credential, events, tenantInfo);
        } catch (error) {
            logger.error(`[CodeBuddy Telemetry] forward failed${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            if (!res.headersSent) {
                sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Telemetry forward failed', 'api_error');
            } else {
                try {res.end();} catch {}
            }
        }
    }

    /**
     * 处理代码统计上报（relay 链路）：/relay/v1/telemetry/report
     * 统一租户模型下，relay 用户的 req.tenantId 即持有 codebuddy 凭证的同一租户，直接取其凭证转发。
     */
    async function handleRelayTelemetryReport(req, res) {
        let tenantInfo = '';
        try {
            const authResult = await resolveCodebuddyCredential(req);
            if (authResult.error) {
                sendOpenAIError(
                    res,
                    authResult.error.status,
                    authResult.error.message,
                    authResult.error.status === 401 ? 'authentication_error' : 'api_error'
                );
                return;
            }
            const {credential} = authResult;
            tenantInfo = `${credential.user_id || 'unknown'}@${safeHost(getCodebuddyBaseUrl(credential.base_url))} (via relay)`;

            const {events, skipped, error} = await readAndValidateEvents(req, parseBody);
            if (error) {
                sendOpenAIError(res, error.status, error.message, error.type);
                return;
            }
            if (skipped) {
                sendJson(res, 200, {skipped: true, reason: skipped});
                return;
            }

            await forwardToCodebuddy(res, credential, events, tenantInfo);
        } catch (error) {
            logger.error(`[CodeBuddy Telemetry] relay forward failed${tenantInfo ? `, ${tenantInfo}` : ''}:`, error);
            if (!res.headersSent) {
                sendOpenAIError(res, upstreamErrorStatus(error), error.message || 'Telemetry forward failed', 'api_error');
            } else {
                try {res.end();} catch {}
            }
        }
    }

    /**
     * 处理 source-check（codebuddy 直连）：/codebuddy/v1/telemetry/source-check
     * codebuddy 直连用户本就走 codebuddy，直接判定可上报。
     */
    async function handleSourceCheck(req, res) {
        try {
            if (!req.tenantId) {
                sendOpenAIError(res, 503, 'CodeBuddy tenant system is not enabled', 'api_error');
                return;
            }
            // codebuddy 直连用户必走 codebuddy，直接判定可上报
            sendJson(res, 200, {codebuddySourced: true, reason: 'codebuddy_direct'});
        } catch (error) {
            logger.error('[CodeBuddy SourceCheck] failed:', error);
            // 保守：异常时返回 false，宁可不报也不误报
            sendJson(res, 200, {codebuddySourced: false, reason: 'check_error'});
        }
    }

    /**
     * 处理 source-check（relay 链路）：/relay/v1/telemetry/source-check
     * 查该 relay 租户自己的活跃上游 → 判定是否 codebuddy 企业站。
     * 用于堵住"别家上游生成的代码被算进 codebuddy 统计"的口子。
     */
    async function handleRelaySourceCheck(req, res) {
        try {
            if (!req.tenantId) {
                sendOpenAIError(res, 503, 'Relay tenant system is not enabled', 'api_error');
                return;
            }

            let upstream = null;
            try {
                const upstreamManager = await tenantManager.getUpstreamManager(req.tenantId);
                upstream = upstreamManager?.getActiveUpstream?.() || null;
            } catch (err) {
                logger.warn(`[CodeBuddy SourceCheck] resolve upstream failed for tenant ${req.tenantId}: ${err.message}`);
            }

            if (!upstream || !upstream.base_url) {
                sendJson(res, 200, {codebuddySourced: false, reason: 'no_upstream'});
                return;
            }

            const host = safeHost(upstream.base_url);
            const codebuddy = isCodebuddyHost(host);
            const personal = isPersonalHost(host);
            const codebuddySourced = codebuddy && !personal;

            sendJson(res, 200, {
                codebuddySourced,
                host,
                reason: codebuddySourced ? 'codebuddy_enterprise' : (codebuddy ? 'codebuddy_personal' : 'non_codebuddy')
            });
        } catch (error) {
            logger.error('[CodeBuddy SourceCheck] relay failed:', error);
            // 保守：异常时返回 false，宁可不报也不误报别家上游
            sendJson(res, 200, {codebuddySourced: false, reason: 'check_error'});
        }
    }

    return {
        handleTelemetryReport,
        handleRelayTelemetryReport,
        handleSourceCheck,
        handleRelaySourceCheck
    };
}

async function readTelemetryRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function createCodebuddyRelayTelemetryHandlers({
    tenantManager,
    resolveCredential,
    sendJson,
    sendOpenAIError,
    upstreamErrorStatus = defaultUpstreamErrorStatus,
    parseBody = readTelemetryRequestBody,
    request = defaultRequest,
    readBody = defaultReadBody,
    logger = console
}) {
    const credentialService = getCodebuddyCredentialService(tenantManager);
    const {
        handleRelayTelemetryReport,
        handleRelaySourceCheck
    } = createCodebuddyTelemetryHandlers({
        tenantManager,
        credentialService,
        resolveCredential,
        getCodebuddyBaseUrl,
        isPersonalHost,
        isCodebuddyHost,
        sendJson,
        sendOpenAIError,
        upstreamErrorStatus,
        parseBody,
        request,
        readBody,
        logger
    });

    return {
        handleRelayTelemetryReport,
        handleRelaySourceCheck
    };
}
