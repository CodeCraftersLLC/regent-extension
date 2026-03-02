/**
 * Token bucket rate limiter — per-user, per-bucket.
 * Tokens refill over time. Returns true if action is allowed.
 */

import { getDb } from '../db/index.js';

/** Check and consume a rate limit token. Returns true if allowed. */
export function checkRateLimit(userId: string, bucket: string, cost = 1): boolean {
  const db = getDb();

  // Upsert bucket with defaults
  db.prepare(`INSERT OR IGNORE INTO rate_limits (user_id, bucket) VALUES (?, ?)`).run(userId, bucket);

  // Refill tokens based on elapsed time
  const row = db.prepare('SELECT * FROM rate_limits WHERE user_id = ? AND bucket = ?').get(userId, bucket) as {
    tokens: number; max_tokens: number; refill_rate: number; last_refill: string;
  };

  const elapsed = (Date.now() - new Date(row.last_refill).getTime()) / 60_000; // minutes
  const refilled = Math.min(row.max_tokens, row.tokens + Math.floor(elapsed * row.refill_rate));

  if (refilled < cost) {
    // Update tokens even if denied (for accurate refill tracking)
    db.prepare("UPDATE rate_limits SET tokens = ?, last_refill = datetime('now') WHERE user_id = ? AND bucket = ?")
      .run(refilled, userId, bucket);
    return false;
  }

  // Consume token
  db.prepare("UPDATE rate_limits SET tokens = ?, last_refill = datetime('now') WHERE user_id = ? AND bucket = ?")
    .run(refilled - cost, userId, bucket);
  return true;
}

/** Get current rate limit status */
export function getRateLimitStatus(userId: string, bucket: string): { tokens: number; maxTokens: number } | null {
  const db = getDb();
  const row = db.prepare('SELECT tokens, max_tokens FROM rate_limits WHERE user_id = ? AND bucket = ?')
    .get(userId, bucket) as { tokens: number; max_tokens: number } | undefined;
  return row ? { tokens: row.tokens, maxTokens: row.max_tokens } : null;
}
