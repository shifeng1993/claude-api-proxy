import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';

const root = process.cwd();

function extractInlineScripts(html) {
    return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
        .map(match => match[1])
        .join('\n');
}

function collectTextFiles(dir, files = []) {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        if (['.git', 'node_modules'].includes(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            collectTextFiles(fullPath, files);
        } else if (/\.(?:js|html|md|json|example|txt|css)$/.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

test('unified admin console includes all service management surfaces', () => {
    assert.equal(existsSync(join(root, 'src/templates/admin.html')), true);
    assert.equal(existsSync(join(root, 'src/templates/login.html')), true);
    assert.equal(existsSync(join(root, 'src/templates/404.html')), true);
    const frontendRoute = readFileSync(join(root, 'src/routes/dashboard-frontend.js'), 'utf8');
    const codebuddyRoute = readFileSync(join(root, 'src/routes/dashboard-codebuddy.js'), 'utf8');
    const codebuddyApiRoute = readFileSync(join(root, 'src/routes/codebuddy.js'), 'utf8');
    const relayApiRoute = readFileSync(join(root, 'src/routes/relay.js'), 'utf8');
    const adminUsersRoute = readFileSync(join(root, 'src/routes/dashboard-users.js'), 'utf8');
    const upstreamManager = readFileSync(join(root, 'src/services/providers/upstream-manager.js'), 'utf8');
    const upstreamModel = readFileSync(join(root, 'src/db/models/tenant-upstream.js'), 'utf8');
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    const statsRoute = readFileSync(join(root, 'src/routes/stats.js'), 'utf8');
    const statsUsage = readFileSync(join(root, 'src/services/gateway/stats-usage.js'), 'utf8');
    const loginHtml = readFileSync(join(root, 'src/templates/login.html'), 'utf8');
    const notFoundHtml = readFileSync(join(root, 'src/templates/404.html'), 'utf8');
    assert.equal(existsSync(join(root, 'src/templates/stats.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/feedback-admin.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/codebuddy-admin.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/relay-admin.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/codebuddy-login.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/relay-login.html')), false);
    assert.equal(existsSync(join(root, 'src/templates/html2canvas.min.js')), false);
    assert.equal(existsSync(join(root, 'src/templates/jspdf.umd.min.js')), false);

    assert.match(frontendRoute, /templates', 'admin\.html'/);
    assert.match(frontendRoute, /\/regenerate-key/);
    assert.match(frontendRoute, /\/upstreams\/test/);
    assert.match(frontendRoute, /\/dashboard\/stats\/overview/);
    assert.match(frontendRoute, /session\.role === 'superadmin' \? tenants : tenants\.filter/);
    assert.doesNotMatch(frontendRoute, /isAdmin \? tenants : tenants\.filter/);
    assert.match(codebuddyRoute, /\/v2\/plugin\/auth\/state/);
    assert.match(codebuddyRoute, /\/codebuddy\/auth\/save/);
    assert.match(codebuddyRoute, /logout_uri/);
    assert.match(adminUsersRoute, /updateManagedUser/);
    assert.match(adminUsersRoute, /method === 'PUT'/);
    assert.match(adminHtml, /Relay/);
    assert.match(adminHtml, /CodeBuddy/);
    assert.match(adminHtml, /useBrowserCodebuddyAuth/);
    assert.match(adminHtml, /pollCodebuddyOAuth/);
    assert.match(adminHtml, /\/codebuddy\/auth\/save/);
    assert.match(adminHtml, /showUsers/);
    const sidebarNav = adminHtml.match(/<aside class="sidebar">[\s\S]*?<\/aside>/)?.[0] || '';
    const codebuddyNavIndex = sidebarNav.indexOf('id="nav-codebuddy"');
    const relayNavIndex = sidebarNav.indexOf('id="nav-relay"');
    assert.ok(relayNavIndex >= 0);
    assert.ok(codebuddyNavIndex > relayNavIndex);
    assert.match(adminHtml, /id="nav-feedback"[^>]*onclick="showFeedback\(\)"/);
    assert.match(adminHtml, /id="nav-stats"[^>]*onclick="showStats\(\)"/);
    assert.doesNotMatch(adminHtml, /统一认证已启用|一个租户 API Key 可访问该租户已启用的服务端点/);
    assert.doesNotMatch(adminHtml, /id="nav-feedback"[^>]*href='\/feedback'/);
    assert.doesNotMatch(adminHtml, /id="nav-stats"[^>]*href='\/stats'/);
    assert.doesNotMatch(adminHtml, /id="tenantSearch"/);
    assert.doesNotMatch(adminHtml, /id="tenantList"/);
    assert.doesNotMatch(adminHtml, /onchange="toggleService/);
    assert.match(adminHtml, /user-service-toggle/);
    assert.match(adminHtml, /serviceToggles=\(u,canManage\)=>/);
    assert.match(adminHtml, /canManage\?\`onchange=/);
    assert.match(adminHtml, /:'disabled'/);
    assert.match(adminHtml, /\.select-control select/);
    assert.match(adminHtml, /appearance: none/);
    assert.ok((adminHtml.match(/class="select-control"/g) || []).length >= 4);
    assert.doesNotMatch(adminHtml, /querySelectorAll\('\.modal'\).*addEventListener\('click'/);
    assert.match(adminHtml, /id="upKeyToggle"/);
    assert.match(adminHtml, /function toggleApiKeyVisibility\(\)/);
    assert.match(adminHtml, /setApiKeyVisibility\(false\)/);
    const proxyFieldIndex = adminHtml.indexOf('id="upProxy"');
    const tlsFieldIndex = adminHtml.indexOf('id="upTls"');
    const modelMapIndex = adminHtml.indexOf('class="model-map"');
    assert.ok(proxyFieldIndex >= 0);
    assert.ok(tlsFieldIndex > proxyFieldIndex);
    assert.ok(modelMapIndex > tlsFieldIndex);
    assert.doesNotMatch(adminHtml, /id="upRetry"/);
    assert.doesNotMatch(adminHtml, /retry_count/);
    assert.doesNotMatch(adminHtml, /id="upMap"/);
    assert.equal((adminHtml.match(/class="model-map-request"/g) || []).length, 3);
    assert.equal((adminHtml.match(/class="model-map-upstream"/g) || []).length, 3);
    assert.match(adminHtml, /value="sonnet"/);
    assert.match(adminHtml, /value="opus"/);
    assert.match(adminHtml, /value="haiku"/);
    assert.match(adminHtml, /function fillModelMappings\(modelMap=\{\}\)/);
    assert.match(adminHtml, /function readModelMappings\(\)/);
    assert.match(adminHtml, /showStats/);
    assert.doesNotMatch(adminHtml, /#\/overview/);
    assert.match(adminHtml, /#\/relay/);
    assert.match(adminHtml, /#\/codebuddy/);
    assert.doesNotMatch(adminHtml, /#\/co[p]ilot/);
    assert.doesNotMatch(adminHtml, /#\/console/);
    assert.match(adminHtml, /#\/stats\/relay\/monthly/);
    assert.match(adminHtml, /#\/stats\/codebuddy\/model-cache/);
    assert.doesNotMatch(adminHtml, /#\/stats\/(?:relay|codebuddy)\/trend/);
    assert.doesNotMatch(adminHtml, /#\/stats\/relay\/users/);
    assert.match(adminHtml, /function routeFromHash\(/);
    assert.match(adminHtml, /function syncHashRoute\(/);
    assert.match(adminHtml, /function syncStatsHash\(/);
    assert.doesNotMatch(adminHtml, /history\.pushState|history\.replaceState/);
    assert.match(adminHtml, /\['relay','codebuddy'\]\.includes\(tab\)\)\{setNav\(tab\);if\(!options\.skipHash\)syncHashRoute\(tab\)/);
    assert.doesNotMatch(adminHtml, /syncHashRoute\('console'/);
    assert.doesNotMatch(adminHtml, /tab==='overview'\?'relay':tab/);
    assert.match(adminHtml, /function loadServiceStats\(type\)/);
    assert.match(adminHtml, /\/public\/js\/echarts\.min\.js/);
    assert.match(adminHtml, /function showFeedback\(\)/);
    assert.match(adminHtml, /function showStats\(\)/);
    assert.match(adminHtml, /const consoleTitle=\{relay:'Relay',codebuddy:'CodeBuddy'\}\[tab\]\|\|'服务管理'/);
    assert.doesNotMatch(adminHtml, /textContent=tab==='overview'\?'APIKey':'服务管理'/);
    assert.match(adminHtml, /const ADMIN_STATS_TABS=\[\['monthly','月度统计'\],\['model-cache','模型分析'\]\]/);
    assert.doesNotMatch(adminHtml, /\['trend','用户趋势'\]|\['coach','使用建议'\]|趋势和使用建议|用户趋势/);
    assert.match(adminHtml, /function renderAdminStatsMonthly\(/);
    assert.doesNotMatch(adminHtml, /function renderAdminStatsUsers\(/);
    assert.match(adminHtml, /function renderAdminStatsModelCache\(/);
    assert.doesNotMatch(adminHtml, /function renderAdminStatsTrend\(/);
    assert.doesNotMatch(adminHtml, /function renderAdminStatsCoach\(/);
    assert.doesNotMatch(adminHtml, /function renderStatsSummaryCards\(/);
    assert.match(adminHtml, /function renderStatsServiceTabs\(/);
    assert.match(adminHtml, /function switchAdminStatsService\(/);
    assert.match(adminHtml, /function defaultStatsDate\(/);
    assert.match(adminHtml, /adminStatsMonth/);
    assert.match(adminHtml, /function defaultStatsMonth\(/);
    assert.match(adminHtml, /function statsMonthRange\(/);
    assert.match(adminHtml, /function applyAdminStatsMonth\(/);
    assert.doesNotMatch(adminHtml, /function searchAdminStatsUsers\(/);
    assert.doesNotMatch(adminHtml, /function clearAdminStatsUserSearch\(/);
    assert.doesNotMatch(adminHtml, /function applyAdminUserDateRange\(/);
    assert.match(adminHtml, /function applyAdminModelDateRange\(/);
    assert.doesNotMatch(adminHtml, /function setAdminUserTrendFilter\(/);
    assert.doesNotMatch(adminHtml, /oninput="updateAdminStatsSearch/);
    assert.match(adminHtml, /\['monthly'/);
    assert.doesNotMatch(adminHtml, /id="adminUserStartDate"/);
    assert.doesNotMatch(adminHtml, /id="adminUserEndDate"/);
    assert.match(adminHtml, /id="adminModelStartDate"/);
    assert.match(adminHtml, /id="adminModelEndDate"/);
    assert.doesNotMatch(adminHtml, /仅工作日/);
    assert.doesNotMatch(adminHtml, /adminTrendWorkdayOnly/);
    assert.match(adminHtml, /输入Tokens\(命中缓存\)/);
    assert.match(adminHtml, /输入Tokens\(未命中缓存\)/);
    assert.match(adminHtml, /缓存命中率/);
    assert.match(adminHtml, /积分/);
    assert.match(adminHtml, /\/stats\/api\/overview/);
    assert.match(adminHtml, /startDate/);
    assert.match(adminHtml, /endDate/);
    assert.match(adminHtml, /p\.set\('month',S\.adminStatsMonth\)/);
    assert.match(adminHtml, /\/stats\/api\/model-cache-stats/);
    assert.doesNotMatch(adminHtml, /\/stats\/api\/daily-trend/);
    assert.doesNotMatch(adminHtml, /\/stats\/api\/key-personnel/);
    assert.match(adminHtml, /adminStatsCharts/);
    assert.match(adminHtml, /function enabledServices\(\)/);
    assert.match(adminHtml, /function canUseService\(type\)/);
    assert.match(adminHtml, /function protocolBaseUrl\(\)/);
    assert.match(adminHtml, /location\.origin\}\/api\/coding/);
    assert.doesNotMatch(adminHtml, /api\.shifeng1993\.com/);
    assert.match(adminHtml, /\/api\/usage/);
    assert.doesNotMatch(adminHtml, /\/api\/stats/);
    assert.doesNotMatch(adminHtml, /id="nav-overview"[^>]*>APIKey<\/button>/);
    assert.doesNotMatch(adminHtml, /showConsole\('overview'\)/);
    assert.doesNotMatch(adminHtml, /const tabs=\[\['overview','APIKey'\]/);
    assert.doesNotMatch(adminHtml, /<div class="tabs">\$\{tabs\.map/);
    assert.doesNotMatch(adminHtml, /enabledServices\(\)\.map\(\(\[type,title,desc,color\]\)=>serviceCard/);
    const overviewRenderer = adminHtml.match(/function renderOverview\(\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(adminHtml, /function renderApiKeyCard\(\)/);
    assert.equal(overviewRenderer, '');
    assert.doesNotMatch(overviewRenderer, /grid-4|grid-3|total_api_calls|total_input_tokens|total_output_tokens|total_cache_hit_tokens|serviceCard/);
    const serviceInsightsRenderer = adminHtml.match(/function serviceInsights\(type\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(serviceInsightsRenderer, /renderApiKeyCard\(\)\}\$\{type==='codebuddy'\?renderCodebuddyModelCard\(\):''\}<div id="section-guide"/);
    assert.match(adminHtml, /switchTab\(S\.tab\|\|'relay',\{skipHash:true\}\);toast\('API Key 已重新生成'\)/);
    assert.match(adminHtml, /total_api_calls|apiCalls/);
    assert.match(adminHtml, /cacheHitRate|CustomCacheRate/);
    assert.doesNotMatch(adminHtml, /写缓存 Tokens|写缓存成本|CustomCacheCreation/);
    assert.doesNotMatch(adminHtml, /input_cache_creation|total_cache_creation_tokens|CustomCacheCreation/);
    assert.doesNotMatch(frontendRoute, /input_cache_creation|total_cache_creation_tokens|cacheCreationTokens/);
    assert.doesNotMatch(codebuddyApiRoute + relayApiRoute, /streamCacheCreationTokens/);
    assert.match(adminHtml, /total_credit|CodeBuddy/);
    assert.match(adminHtml, /echarts\.init/);
    assert.match(adminHtml, /\.service-status\s*\{[\s\S]*position: absolute/);
    assert.match(adminHtml, /class="badge service-status/);
    assert.match(adminHtml, /function renderAnchorNav\(items\)/);
    assert.match(adminHtml, /class="anchor-nav"/);
    assert.match(adminHtml, /\.anchor-nav\s*\{[\s\S]*position: sticky/);
    assert.match(adminHtml, /function scrollToSection\(id\)/);
    assert.match(adminHtml, /onclick="scrollToSection\(\$\{jsArg\(id\)\}\)"/);
    assert.doesNotMatch(adminHtml, /href="#\$\{id\}"/);
    assert.match(adminHtml, /section-relay-list/);
    assert.match(adminHtml, /section-codebuddy-list/);
    const codebuddyRenderer = adminHtml.match(/function renderCodebuddy\(\)\{[^\n]+/)?.[0] || '';
    assert.doesNotMatch(codebuddyRenderer, /<div id="section-codebuddy-models"/);
    assert.match(adminHtml, /function renderCodebuddyModelCard\(\)/);
    assert.match(adminHtml, /section-guide/);
    assert.match(adminHtml, /section-custom-stats/);
    assert.match(adminHtml, /id="section-guide"/);
    assert.match(adminHtml, /id="section-custom-stats"/);
    assert.doesNotMatch(serviceInsightsRenderer, /section-monthly-stats|月度使用统计|\$\{type\}StatsBody|\$\{type\}StatsMonth|loadServiceStats\('\$\{type\}'\)/);
    assert.doesNotMatch(adminHtml, /\['section-monthly-stats','月度使用统计'\]|\['section-monthly-stats','\\u6708\\u5ea6\\u4f7f\\u7528\\u7edf\\u8ba1'\]/);
    const switchTabRenderer = adminHtml.match(/function switchTab\(tab\)\{[^\n]+/)?.[0] || '';
    assert.doesNotMatch(switchTabRenderer, /loadServiceStats\(tab\)|loadServiceStats\(type\)/);
    assert.match(adminHtml, /function renderStatsTabs\(\)/);
    assert.match(adminHtml, /function renderStatsServiceTabs\(\)/);
    assert.match(adminHtml, /function switchAdminStatsService\(type\)/);
    assert.match(adminHtml, /onclick="switchAdminStatsService\('\$\{type\}'\)"/);
    const monthlyRenderer = adminHtml.match(/async function renderAdminStatsMonthly\(force=false\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(monthlyRenderer, /type="month"[^>]*id="adminStatsMonth"/);
    assert.match(monthlyRenderer, /onclick="applyAdminStatsMonth\(\)"/);
    const showStatsRenderer = adminHtml.match(/function showStats\(\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.doesNotMatch(showStatsRenderer, /<h2>使用统计|默认按当天查看|refreshAdminStats\(\)|adminStatsSummary|renderStatsSummaryCards/);
    assert.doesNotMatch(showStatsRenderer, /总用户数|活跃用户数|积分消耗/);
    assert.doesNotMatch(adminHtml, /仅统计当前登录用户，按月份查看。/);
    assert.match(showStatsRenderer, /renderStatsServiceTabs\(\)\}\$\{renderStatsTabs\(\)/);
    assert.match(adminHtml, /S\.adminStats=null;S\.adminModelCache=\[\];S\.adminModelPageNo=1;syncStatsHash\(S\.statsPage\);showStats\(S\.statsPage,\{skipHash:true\}\)/);
    assert.match(adminHtml, /class="tab \$\{S\.statsTab===type\?'active':''\}"/);
    assert.doesNotMatch(adminHtml, /embeddedStatsService/);
    assert.doesNotMatch(adminHtml, /onclick="loadServiceStats\('\$\{type\}'\)"/);
    assert.match(adminHtml, /onclick="refreshServiceStats\('\$\{type\}'\)"/);
    const refreshStats = adminHtml.match(/async function refreshServiceStats\(type\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.doesNotMatch(refreshStats, /loadMyTenant|renderTenant|loadServiceStats/);
    assert.match(adminHtml, /function updateCustomStatsCard\(type, serviceProfile\)/);
    assert.match(adminHtml, /\/service-profile\?service=/);
    assert.match(adminHtml, /stats-grid-\$\{type==='codebuddy'\?'6':'5'\}/);
    assert.match(adminHtml, /moveCodebuddyCredential/);
    assert.match(adminHtml, /id="feedbackDetailModal"/);
    assert.match(adminHtml, /function openInlineFeedbackSubmit\(\)/);
    assert.match(adminHtml, /function openFeedbackDetail\(id\)/);
    assert.match(adminHtml, /function renderFeedbackPagination\(\)/);
    assert.match(adminHtml, /feedbackPageSize/);
    assert.match(adminHtml, /feedbackTotal/);
    assert.match(adminHtml, /S\.feedbackPage-1/);
    assert.match(adminHtml, /S\.feedbackPage\+1/);
    assert.match(adminHtml, /jumpFeedbackPage/);
    assert.doesNotMatch(adminHtml, /id="feedbackSummary"/);
    assert.match(adminHtml, /id="newRole"/);
    assert.match(adminHtml, /id="editUserModal"/);
    assert.match(adminHtml, /function openUserEdit\(/);
    assert.match(adminHtml, /function saveUserEdit\(/);
    assert.match(adminHtml, /\/dashboard\/users\/\$\{encodeURIComponent\(S\.editingUser\)\}/);
    assert.match(adminHtml, /method:'PUT'/);
    assert.match(adminHtml, /value="admin"/);
    assert.match(adminHtml, /openFeedbackDetail/);
    const rowRenderer = adminHtml.match(/function renderInlineFeedbackRow\(item\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.doesNotMatch(rowRenderer, /attachment\/\$\{item\.id\}/);
    assert.doesNotMatch(loginHtml, /autocomplete="(?:username|current-password)"/);
    assert.match(loginHtml, /<form id="loginForm" autocomplete="off"/);
    for (const input of adminHtml.match(/<input\b[^>]*>/g) || []) {
        assert.match(input, /autocomplete="off"/);
    }
    for (const input of loginHtml.match(/<input\b[^>]*>/g) || []) {
        assert.match(input, /autocomplete="off"/);
    }
    assert.doesNotMatch(upstreamManager, /retry_count/);
    assert.doesNotMatch(upstreamManager, /getEnabledUpstreams|recordFailure|recordSuccess/);
    assert.match(upstreamManager, /return this\.listUpstreams\(\)\[this\.upstreams\.length - 1\]/);
    assert.match(upstreamManager, /return this\.listUpstreams\(\)\[index\]/);
    assert.match(upstreamModel, /retry_count/);
    assert.match(loginHtml, /loginForm/);
    assert.match(loginHtml, /linear-gradient\(135deg, var\(--brand\), var\(--brand-2\)\)/);
    assert.match(notFoundHtml, /HTTP 404/);
    assert.match(notFoundHtml, /linear-gradient\(135deg, var\(--brand\), var\(--brand-2\)\)/);
    assert.match(adminHtml, /id="nav-feedback"/);
    assert.match(adminHtml, /id="nav-stats"/);
    assert.match(adminHtml, /id="changeOwnPasswordModal"/);
    assert.match(adminHtml, /id="changeOwnPasswordBtn"/);
    assert.match(adminHtml, /canChangeOwnPassword/);
    assert.match(adminHtml, /style\.display=S\.me\.canChangeOwnPassword===false\?'none':''/);
    assert.match(adminHtml, /function openOwnPassword\(\)/);
    assert.match(adminHtml, /function changeOwnPassword\(\)/);
    assert.match(adminHtml, /\/dashboard\/me\/password/);
    assert.match(adminHtml, /onclick="testUpstream\(\$\{i\}\)"/);
    assert.match(adminHtml, /function testUpstream\(i\)/);
    assert.match(adminHtml, /function fetchWithTimeout\(/);
    assert.match(adminHtml, /timeoutMs:35000/);
    assert.match(adminHtml, /AbortController/);
    assert.match(adminHtml, /id="upEnableResponsesIncremental"/);
    assert.match(adminHtml, /id="upEnableResponsesIncrementalField"[^>]*><input id="upEnableResponsesIncremental"[^>]*> 本跳启用 Responses continuation（使用 previous_response_id 只发送新增输入）<\/label>/);
    assert.match(adminHtml, /onchange="syncUpstreamResponsesOptionsVisibility\(true\)"/);
    assert.match(adminHtml, /syncUpstreamResponsesOptionsVisibility\(false\);/);
    assert.match(adminHtml, /function syncUpstreamResponsesOptionsVisibility\(enableIncrementalByDefault=false\)/);
    assert.match(adminHtml, /if\(show&&enableIncrementalByDefault\)upEnableResponsesIncremental\.checked=true;/);
    assert.match(adminHtml, /disable_responses_continuation:upProtocol\.value==='responses_ws'\?!upEnableResponsesIncremental\.checked:false/);
    assert.match(adminHtml, /本跳 continuation/);
    assert.match(adminHtml, /本跳发送完整 input/);
    assert.doesNotMatch(adminHtml, /每轮消息裁剪为增量/);
    assert.doesNotMatch(adminHtml, /增量裁剪/);
    assert.doesNotMatch(adminHtml, /WS mode/);
    assert.doesNotMatch(adminHtml, /id="upWsMode"/);
    assert.doesNotMatch(adminHtml, /upWsMode(Field|\.value)/);
    assert.doesNotMatch(adminHtml, /WS \$\{esc\(u\.ws_mode/);
    assert.match(adminHtml, /function getRelayWsModeForSave\(\)/);
    assert.match(adminHtml, /ws_mode:getRelayWsModeForSave\(\)/);
    assert.doesNotMatch(adminHtml, /请按链路最终调用的上游协议选择/);
    assert.doesNotMatch(adminHtml, /当前 responses_ws 上游只是中间桥接层/);
    assert.doesNotMatch(adminHtml, /桥接完整 input/);
    assert.doesNotMatch(adminHtml, /Responses 增量 input/);
    assert.doesNotMatch(adminHtml, /关闭 Responses WS 续传优化/);
    assert.match(upstreamManager, /disable_responses_continuation/);
    assert.match(upstreamModel, /disable_responses_continuation/);
    assert.match(loginHtml, /id="forgotPasswordModal"/);
    assert.match(loginHtml, /function openForgotPassword\(\)/);
    const forgotPasswordModal = loginHtml.match(/id="forgotPasswordModal"[\s\S]*?<script>/)?.[0] || '';
    assert.doesNotMatch(forgotPasswordModal, /电话|手机|邮箱|email|mail|tel/i);
    assert.doesNotMatch(adminHtml, /key-personnel/);
    assert.doesNotMatch(adminHtml, /coach-assessment|coach-samples|coach-trigger/);
    assert.doesNotMatch(adminHtml, /disabled-personnel|disabled-trigger/);
    assert.match(statsRoute, /getSessionUser/);
    assert.doesNotMatch(statsRoute, /function isStatsAdmin\(req\)/);
    assert.doesNotMatch(statsRoute, /requireStatsAdmin\(req, res\)/);
    assert.match(statsRoute, /getStatsService\(url\)/);
    assert.match(statsRoute, /statsUsage\.getOverviewStats\(service, startDate, endDate, tenantId\)/);
    assert.match(statsRoute, /statsUsage\.getModelCacheStats\(service, startDate, endDate, tenantId\)/);
    assert.match(statsRoute, /statsUsage\.getUserDetail\(service, username\)/);
    assert.match(statsUsage, /function buildDateRangeWhere\(/);
    assert.match(statsUsage, /function getOverviewStats\(tenantManager, serviceType = 'codebuddy', startDate, endDate, tenantId\)/);
    assert.match(statsUsage, /function getModelCacheStats\(tenantManager, serviceType = 'codebuddy', startDate, endDate, tenantId\)/);
});

test('unified admin inline scripts are syntactically valid', () => {
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    assert.doesNotThrow(() => new Function(extractInlineScripts(adminHtml)));
});

test('unified admin exposes inline event handlers on window', () => {
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    const scripts = extractInlineScripts(adminHtml);

    for (const fn of ['showConsole', 'showFeedback', 'showStats', 'showUsers', 'routeFromHash', 'openUserEdit', 'saveUserEdit', 'applyAdminStatsMonth', 'applyAdminModelDateRange', 'queryAdminModelCache', 'openAdminModelCacheDaily']) {
        assert.match(scripts, new RegExp(`Object\\.assign\\(window,[\\s\\S]*\\b${fn}\\b`));
    }

    const declared = new Set([...scripts.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]));
    const exported = scripts.match(/Object\.assign\(window,\{([\s\S]*?)\}\);/)?.[1] || '';
    const exportedNames = exported.split(',').map(name => name.trim()).filter(Boolean);
    for (const fn of exportedNames) {
        assert.equal(declared.has(fn), true, `${fn} is exported on window but is not declared`);
    }
});

test('admin Claude Code guides document auth compatibility and model pass-through', () => {
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    assert.match(adminHtml, /ANTHROPIC_AUTH_TOKEN/);
    assert.match(adminHtml, /ANTHROPIC_API_KEY/);
    assert.match(adminHtml, /deepseek-v4-pro\[1m\]/);
    assert.match(adminHtml, /如 Codex，将 Base URL 设置为/);
    assert.doesNotMatch(adminHtml, /Cherry Studio|CherryStudio/);
    assert.doesNotMatch(adminHtml, /ANTHROPIC_CUSTOM_HEADERS/);
    assert.match(adminHtml, /loadCodebuddyOptions/);
    assert.match(adminHtml, /renderCodebuddyModelGuide/);
    assert.match(adminHtml, /\/dashboard\/codebuddy\/options/);
    assert.doesNotMatch(readme, /ANTHROPIC_CUSTOM_HEADERS/);
    assert.doesNotMatch(readme, /x-api-key/);
});

test('removed browser PDF export and unused env parser dependencies stay out of runtime package dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

    for (const name of ['html2canvas', 'jspdf', 'dotenv']) {
        assert.equal(pkg.dependencies?.[name], undefined);
        assert.equal(lock.packages?.['']?.dependencies?.[name], undefined);
        assert.equal(lock.packages?.[`node_modules/${name}`], undefined);
    }
});

test('runtime configuration docs cover long task and session knobs', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const envExample = readFileSync(join(root, '.env.example'), 'utf8');
    const requiredKeys = [
        'SESSION_COOKIE_DOMAIN',
        'COOKIE_DOMAIN',
        'DASHBOARD_CORS_ORIGINS',
        'RELAY_CONVERSATION_STATE_MAX_CHAT_MESSAGES',
        'RELAY_CONVERSATION_STATE_MAX_CANONICAL_TURNS',
        'RELAY_RESPONSES_INPUT_ITEMS_LIMIT',
        'RELAY_UPSTREAM_TEST_TIMEOUT_MS',
        'RESPONSES_WS_MODE',
        'RELAY_RESPONSES_WS_MODE',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'DEPLOY_PASSWORD',
        'PAYLOAD_INTERCEPT_DIR',
        'PAYLOAD_INTERCEPT_MAX_FILES',
        'PAYLOAD_INTERCEPT_PREFIX_CHARS'
    ];

    for (const key of requiredKeys) {
        assert.match(readme, new RegExp(key));
        assert.match(envExample, new RegExp(key));
    }
});

test('live architecture docs do not point to removed protocol paths', () => {
    const docs = [
        'README.md',
        'docs/decisions/2026-06-21-cache-creation-rollback.md',
        'docs/architecture-boundaries.md'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    assert.doesNotMatch(docs, /(?:src\/)?transformer\/|src\/core\/protocol/);
});

test('project Chinese text does not contain mojibake markers', () => {
    const files = collectTextFiles(root)
        .filter(file => !file.includes(`${join(root, 'node_modules')}`))
        .filter(file => !file.includes(`${join(root, '.git')}`));
    const mojibake = new RegExp([
        '\\uFFFD',
        '[\\uE000-\\uF8FF]',
        '\\u951b',
        '\\u9286',
        '\\u9225',
        '\\u922e',
        '\\u9239',
        '\\u6fe1\\?',
        '\\u7481\\u5267\\u7586',
        '\\u6dbf\\u5a09\\u6cf6',
        '\\u93c8\\uE047\\u7159',
        '\\u93c8\\u5db6\\u59df'
    ].join('|'));
    const offenders = [];

    for (const file of files) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (mojibake.test(line)) {
                offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
            }
        });
    }

    assert.deepEqual(offenders, []);
});
