# Deploy

Deploy the Claude API Proxy project to the production server.

## Trigger
When the user says "deploy", "部署", "发布", or asks to deploy/publish the project.

## Steps

1. First, check if there are uncommitted changes. Warn the user if there are uncommitted changes and ask whether to proceed.

2. Run the deploy script. It uses `node-ssh` (already in devDependencies) to connect, upload files, install dependencies, and restart PM2 — no system-level sshpass/scp required:

   ```bash
   node scripts/deploy.mjs --password=<password>
   ```

   Or set the `DEPLOY_PASSWORD` environment variable, or run without arguments to be prompted interactively.

3. The script will:
   - Connect to the server via SSH (using node-ssh/ssh2, password-based auth)
   - Upload `src/` directory and config files (`ecosystem.cluster.config.cjs`, `package.json`, `package-lock.json`)
   - Exclude: node_modules, .codebuddy, .relay, .git
   - Run `npm install --omit=dev` on the server
   - Restart PM2 cluster via `pm2 restart ecosystem.cluster.config.cjs`
   - Run health check against http://localhost:3080/health
   - Print PM2 status and health check result

4. Report the deployment result to the user based on the script output.

## Important Notes
- Server, SSH user, path and health check are configured with `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_HEALTH_URL` and related environment variables.
- Default deploy path: /home/claude-api-proxy/
- PM2 cluster config: `ecosystem.cluster.config.cjs` (4 workers on ports 3081-3084)
- Health check port: 3080 (via nginx upstream)
- The deploy script is at `scripts/deploy.mjs`, using `node-ssh` (wraps ssh2) — no need to install sshpass/plink on Windows
- Do NOT upload .codebuddy/ or .relay/ directories - they contain runtime data
- Do NOT upload node_modules/ - npm install will be run on the server
- Do NOT upload .git/ directory
