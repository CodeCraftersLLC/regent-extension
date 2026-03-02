import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Session } from '../../db/schema.js';

export const sessionRoutes = new Hono();
sessionRoutes.use('*', authMiddleware);

/** Verify the authenticated user is a member of the workspace */
function verifyMembership(c: any) {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  if (!member) return null;
  return { wsId, userId, db };
}

// GET /workspaces/:wsId/sessions
sessionRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  const { wsId, db } = ctx;
  const status = c.req.query('status');

  const sql = status
    ? 'SELECT * FROM sessions WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC';
  const params = status ? [wsId, status] : [wsId];

  return c.json(db.prepare(sql).all(...params) as Session[]);
});

// POST /workspaces/:wsId/sessions
sessionRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  const { wsId, db } = ctx;

  const { externalId, name, url, hostname } = await c.req.json<{
    externalId?: string; name?: string; url?: string; hostname?: string;
  }>();

  const id = newId();
  db.prepare(`INSERT INTO sessions (id, workspace_id, external_id, name, url, hostname)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, wsId, externalId ?? null, name ?? null, url ?? null, hostname ?? null);

  return c.json({ id, workspace_id: wsId, status: 'active' }, 201);
});

// PATCH /workspaces/:wsId/sessions/:id — close session
sessionRoutes.patch('/:id', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  const { db } = ctx;

  const { status } = await c.req.json<{ status: 'closed' }>();
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, c.req.param('id'));
  return c.json({ ok: true });
});
