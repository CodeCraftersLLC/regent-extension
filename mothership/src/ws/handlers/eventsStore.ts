import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { bus } from '../../events/bus.js';
import { enqueue, laneKey } from '../../queue/laneQueue.js';
import { log } from '../../utils/logger.js';
import type { Connection } from '../registry.js';
import type { RegentEvent } from '../../db/schema.js';

interface EventPayload {
  sessionId: string;
  sessionName?: string;
  url?: string;
  hostname?: string;
  events: Array<{
    title: string;
    summary: string;
    importance?: string;
    messageIndex?: number;
  }>;
}

/**
 * Handle events:store — extension forwards pre-extracted events.
 * Uses lane queue for per-session serial execution.
 */
export function handleEventsStore(conn: Connection, payload: EventPayload) {
  const { workspaceId } = conn;
  if (!workspaceId) return;

  const { sessionId, events } = payload;
  if (!sessionId || !events?.length) return;

  const key = laneKey(workspaceId, sessionId);

  enqueue(key, async () => {
    const db = getDb();

    // Upsert session
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!existing) {
      db.prepare(`INSERT INTO sessions (id, workspace_id, name, url, hostname, status)
        VALUES (?, ?, ?, ?, ?, 'active')`)
        .run(sessionId, workspaceId, payload.sessionName ?? null, payload.url ?? null, payload.hostname ?? null);
    } else {
      db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
    }

    // Store events
    const insert = db.prepare(`INSERT INTO events (id, session_id, workspace_id, title, summary, importance, message_index, source_tab_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const stored: RegentEvent[] = [];
    const tx = db.transaction(() => {
      for (const evt of events) {
        const id = newId();
        insert.run(id, sessionId, workspaceId, evt.title, evt.summary, evt.importance || 'medium', evt.messageIndex ?? null, conn.tabId);
        stored.push({
          id, session_id: sessionId, workspace_id: workspaceId,
          title: evt.title, summary: evt.summary,
          importance: (evt.importance || 'medium') as RegentEvent['importance'],
          message_index: evt.messageIndex ?? null,
          source_tab_id: conn.tabId, created_at: new Date().toISOString(),
        });
      }
    });
    tx();

    log.info({ sessionId, count: stored.length }, 'Events stored');

    // Broadcast to other tabs in workspace
    bus.emit('events:new', { workspaceId, sessionId, events: stored, sourceTabId: conn.tabId });
  });
}
