import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { sessionRoutes } from './routes/sessions.js';
import { eventRoutes } from './routes/events.js';
import { memoryRoutes } from './routes/memory.js';
import { agentRoutes } from './routes/agents.js';
import { mcpRoutes } from './routes/mcp.js';
import { inviteRoutes, redeemInvite } from './routes/invites.js';
import { notificationRoutes } from './routes/notifications.js';
import { authMiddleware } from './middleware/auth.js';

export const api = new Hono().basePath('/api/v1');

// CORS: pin to specific extension ID or allowed origins — no wildcard
api.use('*', cors({
  origin: (origin) => {
    // Pin to specific extension ID if configured, otherwise allow any chrome-extension
    const extId = process.env.EXTENSION_ID;
    if (extId && origin === `chrome-extension://${extId}`) return origin;
    if (!extId && origin?.startsWith('chrome-extension://')) return origin;
    // Allow configured origins
    const allowed = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()) || [];
    if (origin && allowed.includes(origin)) return origin;
    // Same-origin requests (no Origin header) — return empty to allow but not expose wildcard
    if (!origin) return '';
    return null as any;
  },
}));

// Health check
api.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }));

// Mount routes
api.route('/auth', authRoutes);
api.route('/workspaces', workspaceRoutes);
api.route('/workspaces/:wsId/sessions', sessionRoutes);
api.route('/workspaces/:wsId/events', eventRoutes);
api.route('/workspaces/:wsId/memory', memoryRoutes);
api.route('/workspaces/:wsId/agents', agentRoutes);
api.route('/workspaces/:wsId/mcp', mcpRoutes);
api.route('/workspaces/:wsId/invites', inviteRoutes);
api.route('/notifications', notificationRoutes);

// Invite redemption (under auth)
api.post('/auth/pair', authMiddleware, redeemInvite);
