import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sessionRoutes } from './routes/sessions.js';
import { eventRoutes } from './routes/events.js';
import { memoryRoutes } from './routes/memory.js';

export const api = new Hono().basePath('/api/v1');

api.use('*', cors());

// Health check
api.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }));

// Mount routes
api.route('/auth', authRoutes);
api.route('/workspaces', workspaceRoutes);
api.route('/workspaces/:wsId/sessions', sessionRoutes);
api.route('/workspaces/:wsId/events', eventRoutes);
api.route('/workspaces/:wsId/memory', memoryRoutes);
