import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Session } from '../../db/schema.js';

export const sessionRoutes = new Hono();
sessionRoutes.use('*', authMiddleware);

// GET /workspaces/:wsId/sessions
sessionRoutes.get('/', (c) => {
  const wsId = c.req.param('wsId');
  const status = c.req.query('status'); // optional filter: 'active' | 'closed'
  const db = getDb();

  const sql = status
    ? 'SELECT * FROM sessions WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC';
  const params = status ? [wsId, status] : [wsId];

  return c.json(db.prepare(sql).all(...params) as Session[]);
});

// POST /workspaces/:wsId/sessions
sessionRoutes.post('/', async (c) => {
  const wsId = c.req.param('wsId');
  const { externalId, name, url, hostname } = await c.req.json<{
    externalId?: string; name?: string; url?: string; hostname?: string;
  }>();

  const db = getDb();
  const id = newId();
  db.prepare(`INSERT INTO sessions (id, workspace_id, external_id, name, url, hostname)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, wsId, externalId ?? null, name ?? null, url ?? null, hostname ?? null);

  return c.json({ id, workspace_id: wsId, status: 'active' }, 201);
});

// PATCH /workspaces/:wsId/sessions/:id — close session
sessionRoutes.patch('/:id', async (c) => {
  const { status } = await c.req.json<{ status: 'closed' }>();
  const db = getDb();
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, c.req.param('id'));
  return c.json({ ok: true });
});
