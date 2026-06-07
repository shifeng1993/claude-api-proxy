import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const root = process.cwd();

function extractInlineScripts(html) {
    return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
        .map(match => match[1])
        .join('\n');
}

test('unified admin console includes all service management surfaces', () => {
    assert.equal(existsSync(join(root, 'src/templates/admin.html')), true);
    assert.equal(existsSync(join(root, 'src/templates/login.html')), true);
    assert.equal(existsSync(join(root, 'src/templates/404.html')), true);
    const frontendRoute = readFileSync(join(root, 'src/routes/dashboard-frontend.js'), 'utf8');
    const codebuddyRoute = readFileSync(join(root, 'src/routes/dashboard-codebuddy.js'), 'utf8');
    const adminUsersRoute = readFileSync(join(root, 'src/routes/dashboard-users.js'), 'utf8');
    const upstreamManager = readFileSync(join(root, 'src/services/relay/upstream-manager.js'), 'utf8');
    const upstreamModel = readFileSync(join(root, 'src/db/models/tenant-upstream.js'), 'utf8');
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    const statsRoute = readFileSync(join(root, 'src/routes/stats.js'), 'utf8');
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
    assert.match(codebuddyRoute, /logout_uri/);
    assert.match(adminUsersRoute, /updateLocalUser/);
    assert.match(adminUsersRoute, /method === 'PUT'/);
    assert.match(adminHtml, /Relay/);
    assert.match(adminHtml, /CodeBuddy/);
    assert.match(adminHtml, /showUsers/);
    assert.match(adminHtml, /id="nav-feedback"[^>]*onclick="showFeedback\(\)"/);
    assert.match(adminHtml, /id="nav-stats"[^>]*onclick="showStats\(\)"/);
    assert.doesNotMatch(adminHtml, /id="nav-feedback"[^>]*href='\/feedback'/);
    assert.doesNotMatch(adminHtml, /id="nav-stats"[^>]*href='\/stats'/);
    assert.doesNotMatch(adminHtml, /id="tenantSearch"/);
    assert.doesNotMatch(adminHtml, /id="tenantList"/);
    assert.doesNotMatch(adminHtml, /onchange="toggleService/);
    assert.match(adminHtml, /user-service-toggle/);
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
    assert.match(adminHtml, /GitHub/);
    assert.match(adminHtml, /showStats/);
    assert.match(adminHtml, /#\/console\/overview/);
    assert.match(adminHtml, /#\/console\/relay/);
    assert.match(adminHtml, /#\/console\/codebuddy/);
    assert.match(adminHtml, /#\/console\/copilot/);
    assert.match(adminHtml, /#\/stats\/relay\/users/);
    assert.match(adminHtml, /#\/stats\/codebuddy\/model-cache/);
    assert.match(adminHtml, /#\/stats\/copilot\/trend/);
    assert.doesNotMatch(adminHtml, /#\/stats\/monthly/);
    assert.match(adminHtml, /#\/stats\/relay\/coach/);
    assert.match(adminHtml, /function routeFromHash\(/);
    assert.match(adminHtml, /function syncHashRoute\(/);
    assert.match(adminHtml, /function syncStatsHash\(/);
    assert.doesNotMatch(adminHtml, /history\.pushState|history\.replaceState/);
    assert.match(adminHtml, /\['relay','codebuddy','copilot','overview'\]\.includes\(tab\)&&!options\.skipHash\)syncHashRoute\('console',tab\)/);
    assert.doesNotMatch(adminHtml, /tab==='overview'\?'relay':tab/);
    assert.match(adminHtml, /function loadServiceStats\(type\)/);
    assert.match(adminHtml, /\/public\/js\/echarts\.min\.js/);
    assert.match(adminHtml, /function showFeedback\(\)/);
    assert.match(adminHtml, /function showStats\(\)/);
    assert.match(adminHtml, /function renderAdminStatsUsers\(/);
    assert.match(adminHtml, /function renderAdminStatsModelCache\(/);
    assert.match(adminHtml, /function renderAdminStatsTrend\(/);
    assert.match(adminHtml, /function renderAdminStatsCoach\(/);
    assert.match(adminHtml, /function renderStatsSummaryCards\(/);
    assert.match(adminHtml, /function defaultStatsDate\(/);
    assert.match(adminHtml, /function searchAdminStatsUsers\(/);
    assert.match(adminHtml, /function clearAdminStatsUserSearch\(/);
    assert.match(adminHtml, /function applyAdminUserDateRange\(/);
    assert.match(adminHtml, /function applyAdminModelDateRange\(/);
    assert.match(adminHtml, /function setAdminUserTrendFilter\(/);
    assert.doesNotMatch(adminHtml, /oninput="updateAdminStatsSearch/);
    assert.doesNotMatch(adminHtml, /\['monthly'/);
    assert.match(adminHtml, /id="adminUserStartDate"/);
    assert.match(adminHtml, /id="adminUserEndDate"/);
    assert.match(adminHtml, /id="adminModelStartDate"/);
    assert.match(adminHtml, /id="adminModelEndDate"/);
    assert.match(adminHtml, /仅工作日/);
    assert.match(adminHtml, /adminTrendWorkdayOnly/);
    assert.match(adminHtml, /输入Tokens\(命中缓存\)/);
    assert.match(adminHtml, /输入Tokens\(未命中缓存\)/);
    assert.match(adminHtml, /缓存命中率/);
    assert.match(adminHtml, /积分/);
    assert.match(adminHtml, /\/stats\/api\/overview/);
    assert.match(adminHtml, /startDate/);
    assert.match(adminHtml, /endDate/);
    assert.match(adminHtml, /\/stats\/api\/model-cache-stats/);
    assert.match(adminHtml, /\/stats\/api\/daily-trend/);
    assert.match(adminHtml, /\/stats\/api\/key-personnel/);
    assert.match(adminHtml, /\/stats\/api\/coach-trigger/);
    assert.match(adminHtml, /adminStatsCharts/);
    assert.match(adminHtml, /function enabledServices\(\)/);
    assert.match(adminHtml, /function canUseService\(type\)/);
    assert.match(adminHtml, /function protocolBaseUrl\(\)/);
    assert.match(adminHtml, /location\.origin\}\/api\/coding/);
    assert.doesNotMatch(adminHtml, /api\.shifeng1993\.com/);
    assert.match(adminHtml, /\/api\/usage/);
    assert.doesNotMatch(adminHtml, /\/api\/stats/);
    assert.match(adminHtml, /const tabs=\[\['overview'/);
    assert.match(adminHtml, /enabledServices\(\)\.map\(\(\[type,title,desc,color\]\)=>serviceCard/);
    assert.match(adminHtml, /total_api_calls|apiCalls/);
    assert.match(adminHtml, /cacheHitRate|CustomCacheRate/);
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
    assert.match(adminHtml, /section-guide/);
    assert.match(adminHtml, /section-monthly-stats/);
    assert.match(adminHtml, /section-custom-stats/);
    assert.match(adminHtml, /id="section-guide"/);
    assert.match(adminHtml, /id="section-monthly-stats"/);
    assert.match(adminHtml, /id="section-custom-stats"/);
    assert.match(adminHtml, /function renderStatsTabs\(\)/);
    assert.match(adminHtml, /class="tab \$\{S\.statsTab===type\?'active':''\}"/);
    assert.doesNotMatch(adminHtml, /embeddedStatsService/);
    assert.match(adminHtml, /onclick="loadServiceStats\('\$\{type\}'\)"/);
    assert.match(adminHtml, /onclick="refreshServiceStats\('\$\{type\}'\)"/);
    const refreshStats = adminHtml.match(/async function refreshServiceStats\(type\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.doesNotMatch(refreshStats, /loadMyTenant|renderTenant|loadServiceStats/);
    assert.match(adminHtml, /function updateCustomStatsCard\(type, serviceProfile\)/);
    assert.match(adminHtml, /\/service-profile\?service=/);
    assert.match(adminHtml, /stats-grid-\$\{type==='codebuddy'\?'6':'5'\}/);
    assert.match(adminHtml, /moveCodebuddyCredential/);
    assert.match(adminHtml, /moveCopilotCredential/);
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
    assert.match(adminHtml, /key-personnel/);
    assert.match(adminHtml, /coach-assessment/);
    assert.match(adminHtml, /coach-samples/);
    assert.match(adminHtml, /coach-trigger/);
    assert.doesNotMatch(adminHtml, /disabled-personnel|disabled-trigger/);
    assert.match(statsRoute, /getSessionUser/);
    assert.match(statsRoute, /function isStatsAdmin\(req\)/);
    assert.match(statsRoute, /requireStatsAdmin\(req, res\)/);
    assert.match(statsRoute, /function buildDateRangeWhere\(/);
    assert.match(statsRoute, /getStatsService\(url\)/);
    assert.match(statsRoute, /getOverviewStats\(service, startDate, endDate\)/);
    assert.match(statsRoute, /getModelCacheStats\(service, startDate, endDate\)/);
    assert.match(statsRoute, /getUserDetail\(service, username\)/);
});

test('unified admin inline scripts are syntactically valid', () => {
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    assert.doesNotThrow(() => new Function(extractInlineScripts(adminHtml)));
});

test('unified admin exposes inline event handlers on window', () => {
    const adminHtml = readFileSync(join(root, 'src/templates/admin.html'), 'utf8');
    const scripts = extractInlineScripts(adminHtml);

    for (const fn of ['showConsole', 'showFeedback', 'showStats', 'showUsers', 'routeFromHash', 'openUserEdit', 'saveUserEdit', 'searchAdminStatsUsers', 'clearAdminStatsUserSearch', 'applyAdminUserDateRange', 'applyAdminModelDateRange', 'setAdminUserTrendFilter']) {
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
    assert.doesNotMatch(adminHtml, /ANTHROPIC_CUSTOM_HEADERS/);
    assert.match(adminHtml, /loadCodebuddyOptions/);
    assert.match(adminHtml, /renderCodebuddyModelGuide/);
    assert.match(adminHtml, /\/dashboard\/codebuddy\/options/);
    assert.doesNotMatch(readme, /ANTHROPIC_CUSTOM_HEADERS/);
    assert.doesNotMatch(readme, /x-api-key/);
});
