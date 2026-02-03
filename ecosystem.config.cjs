module.exports = {
    apps: [
        {
            name: 'ClaudeApiProxy',
            script: 'src/index.js',
            interpreter: 'node',
            env: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info'
            },

            env_production: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info'
            }
        }
    ]
};
