import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  // Ephemeral random secret for dev — tokens won't survive restarts
  jwtSecret = randomBytes(32).toString('hex');
  console.warn('[WARN] No JWT_SECRET set — using random ephemeral secret (tokens will not persist across restarts)');
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret,
  dbPath: resolve(process.env.DB_PATH || './data/mothership.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
