require('dotenv').config({ path: '/opt/swarm-mcp-factory/.env' });

module.exports = {
  apps: [{
    name: 'mcp-factory',
    script: 'src/api.js',
    cwd: '/opt/swarm-mcp-factory',
    env: {
      NODE_ENV: 'production',
      PORT: 3456,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    },
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    watch: false,
    max_memory_restart: '500M'
  }]
};
