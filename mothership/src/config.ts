import { resolve } from 'node:path';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET environment variable is required in production');
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret: jwtSecret || 'dev-secret-change-me',
  dbPath: resolve(process.env.DB_PATH || './data/mothership.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
