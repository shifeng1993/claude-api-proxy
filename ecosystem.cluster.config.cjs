const WORKER_COUNT = 4;
const BASE_PORT = 3081;
const HOST = '127.0.0.1';
const LOG_LEVEL = 'info';
const MAX_MEMORY_RESTART = '768M';

function createWorker(index) {
	    const port = BASE_PORT + index;
	    return {
		            name: `ClaudeApiProxy-${port}`,
		            script: 'src/index.js',
		            cwd: __dirname,
		            interpreter: 'node',
		            node_args: '--use-system-ca',
		            exec_mode: 'fork',
		            instances: 1,
		            autorestart: true,
		            max_memory_restart: MAX_MEMORY_RESTART,
		            kill_timeout: 30000,
		            env: {
				                NODE_ENV: 'production',
				                LOG_LEVEL,
				                HOST,
				                PORT: String(port)
				            }
		        };
}

module.exports = {
	    apps: Array.from({length: WORKER_COUNT}, (_, index) => createWorker(index))
};
