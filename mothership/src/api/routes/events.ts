import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { bus } from '../../events/bus.js';
import type { RegentEvent } from '../../db/schema.js';

export const eventRoutes = new Hono();
eventRoutes.use('*', authMiddleware);

/** Verify the authenticated user is a member of the workspace */
function verifyMembership(c: any) {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  if (!member) return null;
  return { wsId, userId, db };
}

// GET /workspaces/:wsId/events — list events, optionally filtered by session
eventRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  const { wsId, db } = ctx;

  const sessionId = c.req.query('sessionId');
  const limit = parseInt(c.req.query('limit') || '100', 10);

  const sql = sessionId
    ? 'SELECT * FROM events WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?';
  const params = sessionId ? [wsId, sessionId, limit] : [wsId, limit];

  return c.json(db.prepare(sql).all(...params) as RegentEvent[]);
});

// POST /workspaces/:wsId/events/bulk — store pre-extracted events from extension
eventRoutes.post('/bulk', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  const { wsId, db } = ctx;

  const { sessionId, events } = await c.req.json<{
    sessionId: string;
    events: Array<{ title: string; summary: string; importance?: string; messageIndex?: number }>;
  }>();

  if (!sessionId || !events?.length) {
    return c.json({ error: 'sessionId and events[] required' }, 400);
  }

  // Ensure session exists (upsert)
  const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existingSession) {
    db.prepare(`INSERT INTO sessions (id, workspace_id, status) VALUES (?, ?, 'active')`).run(sessionId, wsId);
  }

  const insert = db.prepare(`INSERT INTO events (id, session_id, workspace_id, title, summary, importance, message_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const stored: RegentEvent[] = [];
  const tx = db.transaction(() => {
    for (const evt of events) {
      const id = newId();
      insert.run(id, sessionId, wsId, evt.title, evt.summary, evt.importance || 'medium', evt.messageIndex ?? null);
      stored.push({
        id, session_id: sessionId, workspace_id: wsId,
        title: evt.title, summary: evt.summary,
        importance: (evt.importance || 'medium') as RegentEvent['importance'],
        message_index: evt.messageIndex ?? null,
        source_tab_id: null, created_at: new Date().toISOString(),
      });
    }
  });
  tx();

  // Broadcast to all connected tabs in this workspace
  bus.emit('events:new', { workspaceId: wsId, sessionId, events: stored, sourceTabId: null });

  return c.json({ stored: stored.length }, 201);
});
