import { resolve } from 'node:path';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  dbPath: resolve(process.env.DB_PATH || './data/mothership.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
