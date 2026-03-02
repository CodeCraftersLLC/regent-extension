import { serve } from '@hono/node-server';
import { config } from './config.js';
import { api } from './api/index.js';
import { attachWebSocket } from './ws/gateway.js';
import { getDb, closeDb } from './db/index.js';
import { log } from './utils/logger.js';

// Initialize database (runs migrations on first start)
getDb();

// Start HTTP server
const server = serve({ fetch: api.fetch, port: config.port }, (info) => {
  log.info(`Mothership listening on http://localhost:${info.port}`);
});

// Attach WebSocket to the same HTTP server
attachWebSocket(server as any);

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('Shutting down...');
    closeDb();
    server.close();
    process.exit(0);
  });
}
