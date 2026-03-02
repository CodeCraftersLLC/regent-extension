/**
 * Hybrid search: FTS5 full-text + sqlite-vec vector similarity.
 * Merged via Reciprocal Rank Fusion (RRF) for best-of-both ranking.
 */

import { getDb } from '../db/index.js';
import { embed, vectorToBlob } from './embeddings.js';
import { log } from '../utils/logger.js';
import type { MemoryEntry } from '../db/schema.js';

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  source: 'fts' | 'vector' | 'hybrid';
}

const RRF_K = 60; // Standard RRF constant

/** Full-text search via FTS5 with BM25 ranking */
export function searchFTS(workspaceId: string, query: string, limit = 20): SearchResult[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT me.id, me.workspace_id, me.session_id, me.event_id, me.content, me.source_type, me.created_at, rank
    FROM memory_fts fts
    JOIN memory_entries me ON me.rowid = fts.rowid
    WHERE memory_fts MATCH ? AND me.workspace_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(query, workspaceId, limit) as (MemoryEntry & { rank: number })[];

  return rows.map((r, i) => ({
    entry: r,
    score: 1 / (RRF_K + i + 1),
    source: 'fts' as const,
  }));
}

/** Vector similarity search via sqlite-vec */
export function searchVector(workspaceId: string, queryVec: number[], limit = 20): SearchResult[] {
  const db = getDb();
  const blob = vectorToBlob(queryVec);

  // sqlite-vec: find nearest neighbors using vec_distance_cosine
  // We need memory_entries that have embeddings and match workspace
  const rows = db.prepare(`
    SELECT me.id, me.workspace_id, me.session_id, me.event_id, me.content, me.source_type, me.created_at,
      vec_distance_cosine(me.embedding, ?) as distance
    FROM memory_entries me
    WHERE me.workspace_id = ? AND me.embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ?
  `).all(blob, workspaceId, limit) as (MemoryEntry & { distance: number })[];

  return rows.map((r, i) => ({
    entry: r,
    score: 1 / (RRF_K + i + 1),
    source: 'vector' as const,
  }));
}

/** Hybrid search: combine FTS5 + vector results via Reciprocal Rank Fusion */
export async function hybridSearch(
  userId: string,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  limit = Math.min(limit, 100); // Cap to prevent abuse

  // Run FTS search (may fail on malformed query syntax)
  let ftsResults: SearchResult[] = [];
  try {
    ftsResults = searchFTS(workspaceId, query, limit);
  } catch (err) {
    log.debug({ err }, 'FTS search failed, falling back to vector-only');
  }

  // Try vector search (requires embeddings)
  let vecResults: SearchResult[] = [];
  try {
    const embedding = await embed(userId, query);
    if (embedding) {
      vecResults = searchVector(workspaceId, embedding.embedding, limit);
    }
  } catch (err) {
    log.debug({ err }, 'Vector search skipped');
  }

  // If only one source, return it directly
  if (!vecResults.length) return ftsResults.slice(0, limit);
  if (!ftsResults.length) return vecResults.slice(0, limit);

  // RRF merge: accumulate scores by entry ID
  const scores = new Map<string, { entry: MemoryEntry; score: number }>();

  for (const r of ftsResults) {
    const prev = scores.get(r.entry.id);
    scores.set(r.entry.id, {
      entry: r.entry,
      score: (prev?.score ?? 0) + r.score,
    });
  }

  for (const r of vecResults) {
    const prev = scores.get(r.entry.id);
    scores.set(r.entry.id, {
      entry: prev?.entry ?? r.entry,
      score: (prev?.score ?? 0) + r.score,
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({ entry, score, source: 'hybrid' as const }));
}
