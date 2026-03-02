/**
 * Data retention — periodic cleanup of old records.
 * Runs as a simple interval timer (no cron dependency needed).
 */

import { getDb } from '../db/index.js';
import { log } from '../utils/logger.js';

const RETENTION_INTERVAL = 6 * 60 * 60 * 1000; // Run every 6 hours

const POLICIES = [
  { table: 'events', column: 'created_at', days: 90 },
  { table: 'messages', column: 'created_at', days: 30 },
  { table: 'memory_entries', column: 'created_at', days: 180 },
  { table: 'audit_log', column: 'created_at', days: 365 },
] as const;

/** Run one retention pass — delete rows older than policy threshold */
export function runRetention() {
  const db = getDb();

  for (const { table, column, days } of POLICIES) {
    const result = db.prepare(
      `DELETE FROM ${table} WHERE ${column} < datetime('now', '-${days} days')`
    ).run();

    if (result.changes > 0) {
      log.info({ table, deleted: result.changes, days }, 'Retention cleanup');
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start periodic retention (idempotent) */
export function startRetention() {
  if (timer) return;
  runRetention(); // Run immediately on start
  timer = setInterval(runRetention, RETENTION_INTERVAL);
  log.info('Retention scheduler started (every 6h)');
}

/** Stop retention timer */
export function stopRetention() {
  if (timer) clearInterval(timer);
  timer = null;
}
