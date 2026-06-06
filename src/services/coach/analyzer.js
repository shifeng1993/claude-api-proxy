/**
 * AI 分析引擎
 * 基于采样数据和统计数据，调用 Claude API 进行使用质量评估
 * @module services/coach/analyzer
 */

import {getSamples} from './storage.js';
import {models} from '../../db/models/index.js';
import {fn, col, Op} from 'sequelize';
import logger from '../../utils/logger.js';
import {
    COACH_API_BASE,
    COACH_API_KEY,
    COACH_MODEL,
    COACH_MIN_SAMPLES,
    MAX_SAMPLES_IN_PROMPT,
    MAX_CONTENT_LENGTH,
    RETRY_COUNT,
    RETRY_DELAY_MS
} from './config.js';

/**
 * 截断文本内容
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(text, maxLength) {
    if (!text || text.length <= maxLength) return text || '';
    return text.slice(0, maxLength) + '...[TRUNCATED]';
}

/**
 * 从采样数据中提取简化的对话片段用于 prompt
 * @param {object[]} samples
 * @returns {string}
 */
function formatSamplesForPrompt(samples) {
    // 按时间排序，均匀取最多 MAX_SAMPLES_IN_PROMPT 条
    const sorted = [...samples].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const step = Math.max(1, Math.floor(sorted.length / MAX_SAMPLES_IN_PROMPT));
    const selected = sorted.filter((_, i) => i % step === 0).slice(0, MAX_SAMPLES_IN_PROMPT);

    const parts = [];
    for (let i = 0; i < selected.length; i++) {
        const s = selected[i];
        const model = s.model || 'unknown';
        const requestContent = extractMessageContent(s.request);
        const responseContent = extractResponseContent(s.response);

        parts.push(`### 样本 ${i + 1} (模型: ${model}, 时间: ${s.timestamp || 'N/A'})
**用户提问：**
${truncate(requestContent, MAX_CONTENT_LENGTH)}

**AI回复：**
${truncate(responseContent, MAX_CONTENT_LENGTH)}
`);
    }
    return parts.join('\n---\n\n');
}

/**
 * 从请求体中提取消息内容
 */
function extractMessageContent(request) {
    if (!request) return '(无请求数据)';
    // OpenAI 格式
    if (request.messages && Array.isArray(request.messages)) {
        return request.messages.map(m => {
            const role = m.role || 'user';
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `[${role}]: ${truncate(content, 1000)}`;
        }).join('\n');
    }
    // Anthropic 格式
    if (request.system) {
        return `[system]: ${typeof request.system === 'string' ? truncate(request.system, 1000) : truncate(JSON.stringify(request.system), 1000)}`;
    }
    return truncate(JSON.stringify(request), 500);
}

/**
 * 从响应体中提取内容
 */
function extractResponseContent(response) {
    if (!response) return '(流式响应，无完整内容)';
    // 聚合后的内容
    if (response.content && typeof response.content === 'string') {
        return truncate(response.content, MAX_CONTENT_LENGTH);
    }
    if (response.choices && Array.isArray(response.choices)) {
        return response.choices.map(c => {
            const text = c.message?.content || c.text || c.delta?.content || '';
            return truncate(text, 1000);
        }).join('\n');
    }
    if (response.output && Array.isArray(response.output)) {
        return truncate(JSON.stringify(response.output), MAX_CONTENT_LENGTH);
    }
    return truncate(JSON.stringify(response), 500);
}

/**
 * 获取用户月度统计数据
 * @param {number} tenantId - 数据库 tenant.id（数字）
 * @param {string} period - YYYY-MM
 * @returns {Promise<object>}
 */
async function getUserStats(tenantId, period) {
    try {
        const rows = await models.TenantDailyUsage.findAll({
            attributes: [
                [fn('SUM', col('api_calls')), 'apiCalls'],
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('SUM', col('input_cache_hit')), 'cacheHitTokens'],
                [fn('SUM', col('credit')), 'credit']
            ],
            where: {
                tenant_id: tenantId,
                date: {[Op.like]: period + '-%'}
            },
            raw: true
        });

        if (!rows || rows.length === 0) {
            return {apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, credit: 0};
        }

        const r = rows[0];
        const inputTokens = parseInt(r.inputTokens) || 0;
        const cacheHitTokens = parseInt(r.cacheHitTokens) || 0;

        return {
            apiCalls: parseInt(r.apiCalls) || 0,
            inputTokens,
            outputTokens: parseInt(r.outputTokens) || 0,
            cacheHitTokens,
            cacheHitRate: inputTokens > 0 ? Math.round((cacheHitTokens / inputTokens) * 100) : 0,
            credit: parseFloat(r.credit) || 0
        };
    } catch (error) {
        logger.error(`Failed to get user stats for tenant ${tenantId}: ${error.message}`);
        return {apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, credit: 0};
    }
}

/**
 * 获取用户使用的模型列表
 * @param {number} tenantId
 * @param {string} period
 * @returns {Promise<string[]>}
 */
async function getUserModels(tenantId, period) {
    try {
        const rows = await models.TenantDailyUsage.findAll({
            attributes: ['model'],
            where: {
                tenant_id: tenantId,
                date: {[Op.like]: period + '-%'}
            },
            group: ['model'],
            raw: true
        });
        return rows.map(r => r.model).filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * 获取服务类型
 * @param {number} tenantId
 * @returns {Promise<string>}
 */
async function getServiceType(tenantId) {
    try {
        const tenant = await models.Tenant.findByPk(tenantId, {attributes: ['service_type'], raw: true});
        return tenant?.service_type || 'codebuddy';
    } catch {
        return 'codebuddy';
    }
}

/**
 * 获取团队平均 Token 消耗（同服务类型、同周期）
 * @param {string} serviceType
 * @param {string} period
 * @returns {Promise<number>}
 */
async function getTeamAvgTokens(serviceType, period) {
    try {
        const rows = await models.TenantDailyUsage.findAll({
            attributes: [
                [fn('SUM', col('input_tokens')), 'inputTokens'],
                [fn('SUM', col('output_tokens')), 'outputTokens'],
                [fn('COUNT', fn('DISTINCT', col('tenant_id'))), 'userCount']
            ],
            where: {
                service_type: serviceType,
                date: {[Op.like]: period + '-%'}
            },
            raw: true
        });

        if (!rows || rows.length === 0 || !rows[0].userCount) return 0;

        const r = rows[0];
        const totalTokens = (parseInt(r.inputTokens) || 0) + (parseInt(r.outputTokens) || 0);
        return Math.round(totalTokens / parseInt(r.userCount));
    } catch {
        return 0;
    }
}

/**
 * 构造分析 prompt
 * @param {object} tenant - 租户信息 {id, name, username}
 * @param {object} stats - 统计数据
 * @param {object[]} samples - 采样数据
 * @param {string} period - YYYY-MM
 * @returns {string}
 */
function buildPrompt(tenant, stats, samples, teamAvgTokens, models, period) {
    const sampleText = formatSamplesForPrompt(samples);

    return `你是一位AI使用效能教练。请基于以下用户在过去一个月使用AI编程助手的行为数据，对该用户的AI使用质量进行全面评估。

## 用户基本信息
- 姓名: ${tenant.name || tenant.username || '未知'}
- 月度: ${period}

## 用户统计数据
- 总API调用次数: ${stats.apiCalls}
- 总输入Token: ${stats.inputTokens.toLocaleString()}
- 总输出Token: ${stats.outputTokens.toLocaleString()}
- 总Token消耗: ${(stats.inputTokens + stats.outputTokens).toLocaleString()}
- 缓存命中率: ${stats.cacheHitRate}%
- 团队人均Token消耗: ${teamAvgTokens.toLocaleString()}
- 使用的模型: ${models.join(', ') || '未知'}

## 用户请求样本（随机采样 ${samples.length} 条，已脱敏）
${sampleText}

## 分析要求
请从以下5个维度逐一评估该用户的AI使用质量（每个维度评分1-100）：

1. **Prompt质量**：用户是否能够清晰表达需求、提供足够但不过度的上下文、结构化提问
2. **上下文利用**：是否合理利用对话历史、缓存机制，减少重复传输
3. **工具使用**：是否正确使用工具调用/function calling能力（如适用）
4. **追问能力**：是否能够通过迭代追问、细化需求获得更好结果
5. **效率意识**：是否合理控制token消耗，避免冗余请求，选择合适的模型

**重要**：在分析improvements（待改进项）时，必须综合考虑输入和输出两个方面：
- 不要只关注Token消耗量的大小，而要看这些Token消耗是否产出了有价值的输出
- 如果用户消耗了大量输入Token但输出了高质量的代码/方案，说明上下文利用充分，不应作为改进项
- 重点关注：输出质量是否匹配输入成本、是否存在低效重复请求、输出是否真正解决了问题
- Token消耗高本身不是问题，高消耗低产出才是问题

## 输出格式
请严格按以下JSON格式输出，不要输出其他内容：

\`\`\`json
{
  "overall_score": 85,
  "summary": "总体评价，2-3句话概括该用户的AI使用水平",
  "skill_scores": {
    "prompt质量": 85,
    "上下文利用": 70,
    "工具使用": 80,
    "追问能力": 75,
    "效率意识": 90
  },
  "strengths": [
    "具体优势1，需要有数据支撑",
    "具体优势2"
  ],
  "improvements": [
    "待改进1，说明为什么需要改进",
    "待改进2"
  ],
  "recommendations": [
    {
      "category": "prompt质量",
      "priority": "高",
      "advice": "具体可操作的建议",
      "expected_benefit": "预期改善效果"
    }
  ]
}
\`\`\`
`;
}

/**
 * 调用 Claude/LLM API 进行分析
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function callLLMForAnalysis(prompt) {
    const apiKey = COACH_API_KEY;
    const apiBase = COACH_API_BASE;

    if (!apiBase) {
        throw new Error('COACH_API_BASE not configured in config.js');
    }

    const headers = {'Content-Type': 'application/json'};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
        model: COACH_MODEL,
        messages: [
            {role: 'user', content: prompt}
        ],
        max_tokens: 4096,
        temperature: 0.3
    });

    const url = apiBase.endsWith('/v1/chat/completions')
        ? apiBase
        : apiBase.replace(/\/$/, '') + '/v1/chat/completions';

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(120_000)
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LLM API returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';

    // 提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
    }

    return JSON.parse(jsonMatch[0]);
}

/**
 * 执行单用户分析
 * @param {string} tenantKey - 'tenant_X' 格式
 * @param {string} period - YYYY-MM
 * @param {string} triggeredBy - 'scheduled' | 'manual'
 * @returns {Promise<object|null>}
 */
export async function runAnalysis(tenantKey, period, triggeredBy = 'manual') {
    // tenantKey 如 'tenant_1'，提取数字ID
    const tenantId = parseInt(tenantKey.replace('tenant_', ''), 10);
    if (isNaN(tenantId)) {
        logger.error(`Invalid tenant key: ${tenantKey}`);
        return null;
    }

    // 1. 检查采样数量
    const samples = await getSamples(tenantId, period);
    if (samples.length < COACH_MIN_SAMPLES) {
        logger.info(`Tenant ${tenantKey} has only ${samples.length} samples (< ${COACH_MIN_SAMPLES}), skipping analysis`);
        return null;
    }

    // 2. 获取租户信息
    let tenant = null;
    let serviceType = 'codebuddy';
    let username = null;
    try {
        const dbTenant = await models.Tenant.findByPk(tenantId, {raw: true});
        if (dbTenant) {
            tenant = dbTenant;
            serviceType = dbTenant.service_type || 'codebuddy';
            username = dbTenant.username;
        }
    } catch (e) {
        logger.error(`Failed to get tenant info: ${e.message}`);
        return null;
    }

    if (!tenant) {
        logger.error(`Tenant not found: ${tenantId}`);
        return null;
    }

    // 3. 获取统计数据
    const stats = await getUserStats(tenantId, period);
    const models_list = await getUserModels(tenantId, period);
    const teamAvgTokens = await getTeamAvgTokens(serviceType, period);

    // 4. 构造 prompt
    const prompt = buildPrompt(tenant, stats, samples, teamAvgTokens, models_list, period);

    // 5. 创建分析记录（状态：analyzing）
    let assessment;
    try {
        assessment = await models.AiAssessment.create({
            tenant_id: tenantId,
            username,
            period,
            sample_count: samples.length,
            status: 'analyzing',
            triggered_by: triggeredBy
        });
    } catch (e) {
        logger.error(`Failed to create assessment record: ${e.message}`);
        return null;
    }

    // 6. 调用 LLM 分析（带重试）
    let analysis = null;
    let lastError = null;

    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
        try {
            analysis = await callLLMForAnalysis(prompt);
            break;
        } catch (err) {
            lastError = err;
            logger.warn(`Analysis attempt ${attempt}/${RETRY_COUNT} failed: ${err.message}`);
            if (attempt < RETRY_COUNT) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
    }

    // 7. 更新分析记录
    if (analysis) {
        await assessment.update({
            overall_score: analysis.overall_score || 0,
            summary: analysis.summary || '',
            strengths: analysis.strengths || [],
            improvements: analysis.improvements || [],
            recommendations: analysis.recommendations || [],
            skill_scores: analysis.skill_scores || {},
            raw_analysis: JSON.stringify(analysis),
            status: 'completed'
        });
        logger.info(`Analysis completed for ${tenantKey} (${username}), score: ${analysis.overall_score}`);
    } else {
        await assessment.update({
            status: 'failed',
            raw_analysis: lastError?.message || 'Unknown error'
        });
        logger.error(`Analysis failed for ${tenantKey} after ${RETRY_COUNT} attempts`);
    }

    return analysis;
}

/**
 * 批量执行所有重点人员的分析
 * @param {string} period - YYYY-MM
 * @param {string} triggeredBy - 'scheduled' | 'manual'
 * @returns {Promise<{completed: number, failed: number}>}
 */
export async function runBatchAnalysis(period, triggeredBy = 'scheduled') {
    const result = {completed: 0, failed: 0};

    try {
        // 查找所有 is_key_personnel = true 的租户
        const keyPersonnel = await models.Tenant.findAll({
            where: {is_key_personnel: true},
            attributes: ['id'],
            raw: true
        });

        logger.info(`Starting batch analysis for ${keyPersonnel.length} key personnel, period: ${period}`);

        for (const tenant of keyPersonnel) {
            const tenantKey = 'tenant_' + tenant.id;
            try {
                const analysis = await runAnalysis(tenantKey, period, triggeredBy);
                if (analysis) {
                    result.completed++;
                } else {
                    result.failed++;
                }
            } catch (err) {
                logger.error(`Batch analysis failed for ${tenantKey}: ${err.message}`);
                result.failed++;
            }
        }
    } catch (err) {
        logger.error(`Batch analysis error: ${err.message}`);
    }

    logger.info(`Batch analysis done: ${result.completed} completed, ${result.failed} failed`);
    return result;
}