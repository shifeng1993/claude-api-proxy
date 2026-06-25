module.exports = {
    apps: [
        {
            name: 'ClaudeApiProxy',
            script: 'src/index.js',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info',
                NODE_OPTIONS: '--max-old-space-size=768'
            },

            env_production: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info',
                NODE_OPTIONS: '--max-old-space-size=768'
            },
            max_memory_restart: '1000M'
        }
    ]
};
