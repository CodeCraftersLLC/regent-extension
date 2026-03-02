import { Hono } from 'hono';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyMembership } from '../middleware/workspace.js';
import type { Session } from '../../db/schema.js';

export const sessionRoutes = new Hono();
sessionRoutes.use('*', authMiddleware);

const VALID_STATUSES = new Set(['active', 'closed']);

// GET /workspaces/:wsId/sessions — viewer+
sessionRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const status = c.req.query('status');
  if (status && !VALID_STATUSES.has(status)) return c.json({ error: 'Invalid status' }, 400);

  const sql = status
    ? 'SELECT * FROM sessions WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC';
  const params = status ? [ctx.wsId, status] : [ctx.wsId];

  return c.json(ctx.db.prepare(sql).all(...params) as Session[]);
});

// POST /workspaces/:wsId/sessions — member+
sessionRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c, 'member');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { externalId, name, url, hostname } = await c.req.json<{
    externalId?: string; name?: string; url?: string; hostname?: string;
  }>();

  const id = newId();
  ctx.db.prepare(`INSERT INTO sessions (id, workspace_id, external_id, name, url, hostname)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, ctx.wsId, externalId ?? null, name ?? null, url ?? null, hostname ?? null);

  return c.json({ id, workspace_id: ctx.wsId, status: 'active' }, 201);
});

// PATCH /workspaces/:wsId/sessions/:id — close session (member+), scoped to workspace
sessionRoutes.patch('/:id', async (c) => {
  const ctx = verifyMembership(c, 'member');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { status } = await c.req.json<{ status: string }>();
  if (!status || !VALID_STATUSES.has(status)) return c.json({ error: 'Invalid status (must be active or closed)' }, 400);

  const result = ctx.db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?")
    .run(status, c.req.param('id'), ctx.wsId);
  if (result.changes === 0) return c.json({ error: 'Session not found' }, 404);
  return c.json({ ok: true });
});
