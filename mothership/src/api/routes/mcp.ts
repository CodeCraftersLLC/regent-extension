/**
 * MCP REST API — manage MCP server configurations and connections.
 */

import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { connectServer, disconnectServer, getWorkspaceTools } from '../../mcp/pool.js';
import type { McpServer } from '../../db/schema.js';

export const mcpRoutes = new Hono();
mcpRoutes.use('*', authMiddleware);

function verifyMembership(c: any) {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  if (!member) return null;
  return { wsId, userId, db };
}

/** GET /workspaces/:wsId/mcp — list MCP server configs */
mcpRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const servers = ctx.db.prepare('SELECT * FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(ctx.wsId) as McpServer[];

  // Don't expose full config (may contain secrets)
  return c.json(servers.map(s => ({
    id: s.id, name: s.name, transport: s.transport,
    status: s.status, created_at: s.created_at,
    tools: s.tools_cache ? JSON.parse(s.tools_cache).length : 0,
  })));
});

/** POST /workspaces/:wsId/mcp — add MCP server config */
mcpRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { name, transport, config } = await c.req.json<{
    name: string; transport: 'stdio' | 'sse' | 'streamable-http'; config: Record<string, unknown>;
  }>();
  if (!name || !transport || !config) return c.json({ error: 'name, transport, and config required' }, 400);

  const id = newId();
  ctx.db.prepare(`INSERT INTO mcp_servers (id, workspace_id, name, transport, config) VALUES (?, ?, ?, ?, ?)`)
    .run(id, ctx.wsId, name, transport, JSON.stringify(config));

  return c.json({ id, name, transport, status: 'disconnected' }, 201);
});

/** POST /workspaces/:wsId/mcp/:id/connect */
mcpRoutes.post('/:id/connect', async (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const serverId = c.req.param('id');
  const server = ctx.db.prepare('SELECT 1 FROM mcp_servers WHERE id = ? AND workspace_id = ?')
    .get(serverId, ctx.wsId);
  if (!server) return c.json({ error: 'Server not found' }, 404);

  try {
    const { tools } = await connectServer(serverId);
    return c.json({ status: 'connected', tools });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/** POST /workspaces/:wsId/mcp/:id/disconnect */
mcpRoutes.post('/:id/disconnect', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  disconnectServer(c.req.param('id'));
  return c.json({ ok: true });
});

/** DELETE /workspaces/:wsId/mcp/:id */
mcpRoutes.delete('/:id', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const serverId = c.req.param('id');
  disconnectServer(serverId);
  const result = ctx.db.prepare('DELETE FROM mcp_servers WHERE id = ? AND workspace_id = ?')
    .run(serverId, ctx.wsId);
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

/** GET /workspaces/:wsId/mcp/tools — aggregated tool list */
mcpRoutes.get('/tools', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  return c.json(getWorkspaceTools(ctx.wsId));
});
