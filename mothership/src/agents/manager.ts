/**
 * Agent Manager — CRUD + lifecycle for workspace agents.
 */

import { getDb } from '../db/index.js';
import { newId } from '../utils/id.js';
import type { Agent } from '../db/schema.js';

export function createAgent(workspaceId: string, opts: { name: string; systemPrompt?: string; mcpServers?: string[] }): Agent {
  const db = getDb();
  const id = newId();
  const mcpServers = opts.mcpServers?.length ? JSON.stringify(opts.mcpServers) : null;

  db.prepare(`INSERT INTO agents (id, workspace_id, name, system_prompt, mcp_servers)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, workspaceId, opts.name, opts.systemPrompt ?? null, mcpServers);

  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
}

export function listAgents(workspaceId: string): Agent[] {
  const db = getDb();
  return db.prepare('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId) as Agent[];
}

export function getAgent(id: string): Agent | null {
  const db = getDb();
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | null;
}

export function deleteAgent(id: string, workspaceId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return result.changes > 0;
}
