/**
 * HTTP 服务器核心逻辑
 * @module server
 */

import http from 'http';
import {URL} from 'url';
import logger from './utils/logger.js';
import {routeCopilotRequest} from './routes/copilot.js';
import {routeCopilotFrontend} from './routes/copilot-frontend.js';
import {routeCodebuddyRequest} from './routes/codebuddy.js';
import {routeCodebuddyFrontend} from './routes/codebuddy-frontend.js';
import {routeRelayRequest} from './routes/relay.js';
import {routeRelayFrontend} from './routes/relay-frontend.js';

function sendJson(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
    res.writeHead(status, {'Content-Type': 'text/plain'});
    res.end(message);
}

export function createServer() {
    return http.createServer(async (req, res) => {
        // 只打印已知路由的请求日志，忽略遥测等无关请求
        const isKnown =
            req.url.startsWith('/copilotFE') ||
            req.url.startsWith('/copilot/') ||
            req.url.startsWith('/copilot/anthropic/v1/') ||
            req.url.startsWith('/codebuddyFE') ||
            req.url.startsWith('/codebuddy/v1/') ||
            req.url.startsWith('/codebuddy/anthropic/v1/') ||
            req.url.startsWith('/relayFE') ||
            req.url.startsWith('/relay/v1/') ||
            req.url.startsWith('/relay/anthropic/v1/');
        if (isKnown) {
            logger.info(`${req.method} ${req.url}`);
        }

        // Copilot 前端管理界面（必须在 /copilot 通用路由之前）
        if (req.url.startsWith('/copilotFE')) {
            try {
                await routeCopilotFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Copilot frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Copilot 路由
        if (req.url.startsWith('/copilot')) {
            try {
                await routeCopilotRequest(req, res);
                return;
            } catch (err) {
                logger.error('Copilot route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 前端管理界面
        if (req.url.startsWith('/relayFE')) {
            try {
                await routeRelayFrontend(req, res);
                return;
            } catch (err) {
                logger.error('Relay frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // Relay 路由
        if (req.url.startsWith('/relay')) {
            try {
                await routeRelayRequest(req, res);
                return;
            } catch (err) {
                logger.error('Relay route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 前端管理界面
        if (req.url.startsWith('/codebuddyFE')) {
            try {
                await routeCodebuddyFrontend(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy frontend error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // CodeBuddy 路由
        if (req.url.startsWith('/codebuddy')) {
            try {
                await routeCodebuddyRequest(req, res);
                return;
            } catch (err) {
                logger.error('CodeBuddy route error:', err);
                sendError(res, 500, 'Internal server error');
                return;
            }
        }

        // 根路径欢迎信息
        if (req.method === 'GET' && req.url === '/') {
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude API Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { max-width: 640px; width: 100%; padding: 48px 24px; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { color: #8b949e; margin-bottom: 40px; font-size: 0.95rem; }
    .cards { display: flex; flex-direction: column; gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px 24px; text-decoration: none; color: inherit; display: flex; align-items: center; justify-content: space-between; transition: border-color 0.2s, background 0.2s; }
    .card:hover { border-color: #58a6ff; background: #1c2230; }
    .card-info { display: flex; flex-direction: column; gap: 4px; }
    .card-title { font-size: 1rem; font-weight: 600; color: #f0f6fc; }
    .card-desc { font-size: 0.85rem; color: #8b949e; }
    .card-arrow { color: #58a6ff; font-size: 1.2rem; }
    .badge { display: inline-block; font-size: 0.72rem; padding: 2px 8px; border-radius: 20px; margin-top: 4px; background: #21262d; color: #79c0ff; border: 1px solid #388bfd44; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude API Proxy</h1>
    <p class="subtitle">统一管理 Copilot、CodeBuddy、Relay 三个代理服务</p>
    <div class="cards">
      <a class="card" href="/copilotFE">
        <div class="card-info">
          <span class="card-title">GitHub Copilot</span>
          <span class="card-desc">Copilot 账号管理与 API 代理</span>
          <span class="badge">/copilotFE &nbsp;·&nbsp; /copilot</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/codebuddyFE">
        <div class="card-info">
          <span class="card-title">CodeBuddy</span>
          <span class="card-desc">CodeBuddy 账号管理与 API 代理</span>
          <span class="badge">/codebuddyFE &nbsp;·&nbsp; /codebuddy</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
      <a class="card" href="/relayFE">
        <div class="card-info">
          <span class="card-title">Relay</span>
          <span class="card-desc">上游 LLM 中继代理</span>
          <span class="badge">/relayFE &nbsp;·&nbsp; /relay</span>
        </div>
        <span class="card-arrow">→</span>
      </a>
    </div>
  </div>
</body>
</html>`;
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(html);
            return;
        }

        sendError(res, 404, 'Not found');
    });
}
