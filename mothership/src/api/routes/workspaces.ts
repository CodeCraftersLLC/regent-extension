import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkRateLimit } from '../../utils/rateLimit.js';
import type { Workspace } from '../../db/schema.js';

export const workspaceRoutes = new Hono();
workspaceRoutes.use('*', authMiddleware);

// GET /workspaces — list user's workspaces
workspaceRoutes.get('/', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  const rows = db.prepare(`
    SELECT w.* FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY w.created_at DESC
  `).all(userId) as Workspace[];
  return c.json(rows);
});

// POST /workspaces — rate limited
workspaceRoutes.post('/', async (c) => {
  const { userId } = c.get('auth');
  const { name } = await c.req.json<{ name: string }>();
  if (!name || name.length > 128) return c.json({ error: 'Name required (max 128 chars)' }, 400);

  // Rate limit workspace creation
  if (!checkRateLimit(userId, 'workspace_create', 5)) {
    return c.json({ error: 'Too many workspaces created, try again later' }, 429);
  }

  const db = getDb();
  const id = newId();

  // Atomic: create workspace + owner membership in one transaction
  db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)').run(id, name, userId);
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(id, userId, 'owner');
  })();

  return c.json({ id, name, owner_id: userId }, 201);
});

// GET /workspaces/:id
workspaceRoutes.get('/:id', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  const ws = db.prepare(`
    SELECT w.* FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE w.id = ? AND wm.user_id = ?
  `).get(c.req.param('id'), userId) as Workspace | undefined;

  if (!ws) return c.json({ error: 'Not found' }, 404);
  return c.json(ws);
});
