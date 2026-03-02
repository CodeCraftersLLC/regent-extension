/**
 * MCP REST API — manage MCP server configurations and connections.
 * All mutating MCP operations require admin+ role.
 */

import { Hono } from 'hono';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyMembership } from '../middleware/workspace.js';
import { connectServer, disconnectServer, getWorkspaceTools } from '../../mcp/pool.js';
import type { McpServer } from '../../db/schema.js';

export const mcpRoutes = new Hono();
mcpRoutes.use('*', authMiddleware);

/** Verify server belongs to workspace — returns server row or null */
function getServerInWorkspace(db: any, serverId: string, wsId: string) {
  return db.prepare('SELECT 1 FROM mcp_servers WHERE id = ? AND workspace_id = ?').get(serverId, wsId);
}

/** GET /workspaces/:wsId/mcp — list MCP server configs (viewer+) */
mcpRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const servers = ctx.db.prepare('SELECT * FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(ctx.wsId) as McpServer[];

  return c.json(servers.map(s => ({
    id: s.id, name: s.name, transport: s.transport,
    status: s.status, created_at: s.created_at,
    tools: s.tools_cache ? JSON.parse(s.tools_cache).length : 0,
  })));
});

/** POST /workspaces/:wsId/mcp — add MCP server config (admin+) */
mcpRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { name, transport, config } = await c.req.json<{
    name: string; transport: 'stdio' | 'sse' | 'streamable-http'; config: Record<string, unknown>;
  }>();
  if (!name || !transport || !config) return c.json({ error: 'name, transport, and config required' }, 400);
  if (name.length > 256) return c.json({ error: 'name too long (max 256 chars)' }, 400);

  const id = newId();
  ctx.db.prepare(`INSERT INTO mcp_servers (id, workspace_id, name, transport, config) VALUES (?, ?, ?, ?, ?)`)
    .run(id, ctx.wsId, name, transport, JSON.stringify(config));

  return c.json({ id, name, transport, status: 'disconnected' }, 201);
});

/** POST /workspaces/:wsId/mcp/:id/connect (admin+) */
mcpRoutes.post('/:id/connect', async (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const serverId = c.req.param('id');
  if (!getServerInWorkspace(ctx.db, serverId, ctx.wsId)) return c.json({ error: 'Server not found' }, 404);

  try {
    const { tools } = await connectServer(serverId);
    return c.json({ status: 'connected', tools });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/** POST /workspaces/:wsId/mcp/:id/disconnect (admin+) — verify ownership */
mcpRoutes.post('/:id/disconnect', (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const serverId = c.req.param('id');
  if (!getServerInWorkspace(ctx.db, serverId, ctx.wsId)) return c.json({ error: 'Server not found' }, 404);

  disconnectServer(serverId);
  return c.json({ ok: true });
});

/** DELETE /workspaces/:wsId/mcp/:id (admin+) */
mcpRoutes.delete('/:id', (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const serverId = c.req.param('id');
  disconnectServer(serverId);
  const result = ctx.db.prepare('DELETE FROM mcp_servers WHERE id = ? AND workspace_id = ?')
    .run(serverId, ctx.wsId);
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

/** GET /workspaces/:wsId/mcp/tools — aggregated tool list (viewer+) */
mcpRoutes.get('/tools', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  return c.json(getWorkspaceTools(ctx.wsId));
});
