import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { bus } from '../../events/bus.js';
import { enqueue, laneKey } from '../../queue/laneQueue.js';
import { embed, vectorToBlob } from '../../memory/embeddings.js';
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

    const insert = db.prepare(`INSERT INTO events (id, session_id, workspace_id, title, summary, importance, message_index, source_tab_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    // Atomic: upsert session + store all events in one transaction
    const stored: RegentEvent[] = [];
    db.transaction(() => {
      const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
      if (!existing) {
        db.prepare(`INSERT INTO sessions (id, workspace_id, name, url, hostname, status)
          VALUES (?, ?, ?, ?, ?, 'active')`)
          .run(sessionId, workspaceId, payload.sessionName ?? null, payload.url ?? null, payload.hostname ?? null);
      } else {
        db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
      }

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
    })();

    log.info({ sessionId, count: stored.length }, 'Events stored');

    // Broadcast to other tabs in workspace
    bus.emit('events:new', { workspaceId, sessionId, events: stored, sourceTabId: conn.tabId });

    // Auto-embed events into memory_entries (fire-and-forget, non-blocking)
    autoEmbed(conn.userId, workspaceId, sessionId, stored).catch((err) => {
      log.warn({ err, sessionId }, 'Auto-embed failed');
    });
  });
}

/** Create memory entries with embeddings for stored events */
async function autoEmbed(userId: string, workspaceId: string, sessionId: string, events: RegentEvent[]) {
  const db = getDb();
  const insert = db.prepare(`INSERT INTO memory_entries (id, workspace_id, session_id, event_id, content, embedding, source_type)
    VALUES (?, ?, ?, ?, ?, ?, 'event')`);

  for (const evt of events) {
    const content = `${evt.title}: ${evt.summary}`;
    let embeddingBlob: Buffer | null = null;

    try {
      const result = await embed(userId, content);
      if (result) embeddingBlob = vectorToBlob(result.embedding);
    } catch (err) {
      log.debug({ err, eventId: evt.id }, 'Embedding failed');
    }

    try {
      insert.run(newId(), workspaceId, sessionId, evt.id, content, embeddingBlob);
    } catch (err) {
      log.debug({ err, eventId: evt.id }, 'Memory entry insert failed');
    }
  }
}
