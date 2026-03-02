import { Hono } from 'hono';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyMembership } from '../middleware/workspace.js';
import { bus } from '../../events/bus.js';
import type { RegentEvent } from '../../db/schema.js';

export const eventRoutes = new Hono();
eventRoutes.use('*', authMiddleware);

// GET /workspaces/:wsId/events — list events (viewer+)
eventRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const sessionId = c.req.query('sessionId');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 1000);

  const sql = sessionId
    ? 'SELECT * FROM events WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?';
  const params = sessionId ? [ctx.wsId, sessionId, limit] : [ctx.wsId, limit];

  return c.json(ctx.db.prepare(sql).all(...params) as RegentEvent[]);
});

// POST /workspaces/:wsId/events/bulk — store events (member+), capped batch size
eventRoutes.post('/bulk', async (c) => {
  const ctx = verifyMembership(c, 'member');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { sessionId, events } = await c.req.json<{
    sessionId: string;
    events: Array<{ title: string; summary: string; importance?: string; messageIndex?: number }>;
  }>();

  if (!sessionId || !events?.length) {
    return c.json({ error: 'sessionId and events[] required' }, 400);
  }
  if (events.length > 200) {
    return c.json({ error: 'Too many events (max 200 per batch)' }, 400);
  }

  const insert = ctx.db.prepare(`INSERT INTO events (id, session_id, workspace_id, title, summary, importance, message_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  // Atomic: upsert session + store all events in one transaction
  const stored: RegentEvent[] = [];
  ctx.db.transaction(() => {
    const existingSession = ctx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!existingSession) {
      ctx.db.prepare(`INSERT INTO sessions (id, workspace_id, status) VALUES (?, ?, 'active')`).run(sessionId, ctx.wsId);
    }

    for (const evt of events) {
      const id = newId();
      insert.run(id, sessionId, ctx.wsId, evt.title, evt.summary, evt.importance || 'medium', evt.messageIndex ?? null);
      stored.push({
        id, session_id: sessionId, workspace_id: ctx.wsId,
        title: evt.title, summary: evt.summary,
        importance: (evt.importance || 'medium') as RegentEvent['importance'],
        message_index: evt.messageIndex ?? null,
        source_tab_id: null, created_at: new Date().toISOString(),
      });
    }
  })();

  bus.emit('events:new', { workspaceId: ctx.wsId, sessionId, events: stored, sourceTabId: null });

  return c.json({ stored: stored.length }, 201);
});
