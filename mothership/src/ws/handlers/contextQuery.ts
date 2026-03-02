/**
 * Handle context:query — search memory from extension via WebSocket.
 * Returns hybrid search results (FTS5 + vector).
 */

import { hybridSearch } from '../../memory/search.js';
import { log } from '../../utils/logger.js';
import type { Connection } from '../registry.js';
import type { WebSocket } from 'ws';

interface QueryPayload {
  query: string;
  limit?: number;
  correlationId?: string;
}

export async function handleContextQuery(conn: Connection, payload: QueryPayload, send: (ws: WebSocket, msg: any) => void) {
  const { workspaceId, userId } = conn;
  if (!workspaceId) return;

  const { query, limit, correlationId } = payload;
  if (!query) {
    send(conn.ws, { type: 'error', payload: { message: 'query required' }, correlationId });
    return;
  }

  try {
    const results = await hybridSearch(userId, workspaceId, query, limit || 20);

    send(conn.ws, {
      type: 'context:results',
      payload: results.map(r => ({
        id: r.entry.id,
        content: r.entry.content,
        source_type: r.entry.source_type,
        session_id: r.entry.session_id,
        event_id: r.entry.event_id,
        created_at: r.entry.created_at,
        score: r.score,
      })),
      correlationId,
    });
  } catch (err) {
    log.warn({ err, userId }, 'Context query failed');
    send(conn.ws, { type: 'error', payload: { message: 'Search failed' }, correlationId });
  }
}
