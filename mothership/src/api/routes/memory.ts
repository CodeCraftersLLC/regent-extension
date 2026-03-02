/**
 * Memory API — search + CRUD for memory entries.
 * Workspace-scoped, requires authentication.
 */

import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { hybridSearch } from '../../memory/search.js';
import { embed, vectorToBlob } from '../../memory/embeddings.js';
import type { MemoryEntry } from '../../db/schema.js';

export const memoryRoutes = new Hono();
memoryRoutes.use('*', authMiddleware);

function verifyMembership(c: any) {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  if (!member) return null;
  return { wsId, userId, db };
}

/** POST /workspaces/:wsId/memory/search — hybrid search */
memoryRoutes.post('/search', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { query, limit } = await c.req.json<{ query: string; limit?: number }>();
  if (!query) return c.json({ error: 'query required' }, 400);

  const results = await hybridSearch(ctx.userId, ctx.wsId, query, limit || 20);

  return c.json(results.map(r => ({
    id: r.entry.id,
    content: r.entry.content,
    source_type: r.entry.source_type,
    session_id: r.entry.session_id,
    event_id: r.entry.event_id,
    created_at: r.entry.created_at,
    score: r.score,
    source: r.source,
  })));
});

/** GET /workspaces/:wsId/memory — list recent memory entries */
memoryRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const limit = parseInt(c.req.query('limit') || '50', 10);
  const sessionId = c.req.query('sessionId');

  const sql = sessionId
    ? 'SELECT id, workspace_id, session_id, event_id, content, source_type, created_at FROM memory_entries WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT id, workspace_id, session_id, event_id, content, source_type, created_at FROM memory_entries WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?';
  const params = sessionId ? [ctx.wsId, sessionId, limit] : [ctx.wsId, limit];

  return c.json(ctx.db.prepare(sql).all(...params));
});

/** POST /workspaces/:wsId/memory — create a memory entry (note/summary) */
memoryRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { content, sourceType, sessionId, eventId } = await c.req.json<{
    content: string; sourceType?: string; sessionId?: string; eventId?: string;
  }>();
  if (!content) return c.json({ error: 'content required' }, 400);

  const id = newId();
  const type = sourceType === 'summary' ? 'summary' : sourceType === 'note' ? 'note' : 'event';

  // Try to generate embedding
  let embeddingBlob: Buffer | null = null;
  const result = await embed(ctx.userId, content);
  if (result) embeddingBlob = vectorToBlob(result.embedding);

  ctx.db.prepare(`INSERT INTO memory_entries (id, workspace_id, session_id, event_id, content, embedding, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.wsId, sessionId ?? null, eventId ?? null, content, embeddingBlob, type);

  return c.json({ id, source_type: type }, 201);
});

/** DELETE /workspaces/:wsId/memory/:id */
memoryRoutes.delete('/:id', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const result = ctx.db.prepare('DELETE FROM memory_entries WHERE id = ? AND workspace_id = ?')
    .run(c.req.param('id'), ctx.wsId);

  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
