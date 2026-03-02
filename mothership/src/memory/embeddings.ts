/**
 * Provider-agnostic embedding client.
 * Uses the user's own API provider (OpenAI-compatible /v1/embeddings format).
 * Credentials stored per-user in provider_credentials table.
 */

import { getDb } from '../db/index.js';
import { log } from '../utils/logger.js';
import type { ProviderCredential } from '../db/schema.js';

/** Default embedding model per provider */
const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
  deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-embedding' },
  openrouter: { url: 'https://openrouter.ai/api/v1', model: 'openai/text-embedding-3-small' },
  siliconflow: { url: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
  openai: { url: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
};

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

/** Get user's provider credentials from DB */
export function getProviderCredentials(userId: string): ProviderCredential | null {
  const db = getDb();
  return db.prepare('SELECT * FROM provider_credentials WHERE user_id = ?').get(userId) as ProviderCredential | null;
}

/** Store/update provider credentials */
export function upsertProviderCredentials(userId: string, creds: { provider: string; apiKey: string; apiUrl?: string; model?: string }) {
  const db = getDb();
  db.prepare(`INSERT INTO provider_credentials (user_id, provider, api_key, api_url, model, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, api_key=excluded.api_key,
    api_url=excluded.api_url, model=excluded.model, updated_at=datetime('now')`)
    .run(userId, creds.provider, creds.apiKey, creds.apiUrl ?? null, creds.model ?? null);
}

/** Generate embedding vector for text using user's configured provider */
export async function embed(userId: string, text: string): Promise<EmbeddingResult | null> {
  const creds = getProviderCredentials(userId);
  if (!creds) return null;

  const defaults = PROVIDER_DEFAULTS[creds.provider] ?? {};
  const baseUrl = (creds.api_url || defaults.url || '').replace(/\/+$/, '');
  const model = creds.model || defaults.model;

  if (!baseUrl || !model) {
    log.warn({ userId, provider: creds.provider }, 'No embedding URL/model configured');
    return null;
  }

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.api_key}`,
      },
      body: JSON.stringify({ input: text, model }),
    });

    if (!res.ok) {
      log.warn({ status: res.status, provider: creds.provider }, 'Embedding API error');
      return null;
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    const vec = data.data?.[0]?.embedding;
    if (!vec?.length) return null;

    return { embedding: vec, dimensions: vec.length };
  } catch (err) {
    log.warn({ err, provider: creds.provider }, 'Embedding request failed');
    return null;
  }
}

/** Serialize float32 array to Buffer for sqlite-vec storage */
export function vectorToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Deserialize Buffer back to float32 array */
export function blobToVector(buf: Buffer): number[] {
  const vec: number[] = [];
  for (let i = 0; i < buf.length; i += 4) vec.push(buf.readFloatLE(i));
  return vec;
}
