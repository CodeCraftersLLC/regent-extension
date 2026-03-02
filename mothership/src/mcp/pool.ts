/**
 * MCP Connection Pool — per-workspace MCP client management.
 * Lazily connects, caches tool schemas, health checks.
 */

import { getDb } from '../db/index.js';
import { McpClient, type McpTool, type McpClientConfig } from './client.js';
import { log } from '../utils/logger.js';
import type { McpServer } from '../db/schema.js';

/** Active MCP client instances keyed by server ID */
const clients = new Map<string, McpClient>();

/** Get or create an MCP client for a server config */
export async function connectServer(serverId: string): Promise<{ tools: McpTool[] }> {
  const db = getDb();
  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId) as McpServer | null;
  if (!server) throw new Error(`MCP server not found: ${serverId}`);

  // Disconnect existing client if any
  disconnectServer(serverId);

  const config = JSON.parse(server.config) as McpClientConfig;
  config.transport = server.transport;

  const client = new McpClient(config);

  try {
    const tools = await client.connect();

    clients.set(serverId, client);

    // Cache tools and update status
    db.prepare("UPDATE mcp_servers SET status = 'connected', tools_cache = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(tools), serverId);

    log.info({ serverId, toolCount: tools.length }, 'MCP server connected');
    return { tools };
  } catch (err) {
    db.prepare("UPDATE mcp_servers SET status = 'error', updated_at = datetime('now') WHERE id = ?")
      .run(serverId);
    throw err;
  }
}

/** Disconnect an MCP client */
export function disconnectServer(serverId: string) {
  const client = clients.get(serverId);
  if (client) {
    client.disconnect();
    clients.delete(serverId);
  }

  const db = getDb();
  db.prepare("UPDATE mcp_servers SET status = 'disconnected', updated_at = datetime('now') WHERE id = ?")
    .run(serverId);
}

/** Get an active MCP client */
export function getClient(serverId: string): McpClient | undefined {
  return clients.get(serverId);
}

/** Get all tools from all connected MCP servers in a workspace */
export function getWorkspaceTools(workspaceId: string): Array<McpTool & { serverId: string }> {
  const db = getDb();
  const servers = db.prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? AND status = 'connected'")
    .all(workspaceId) as McpServer[];

  const tools: Array<McpTool & { serverId: string }> = [];
  for (const server of servers) {
    const client = clients.get(server.id);
    if (client?.connected) {
      for (const tool of client.tools) {
        tools.push({ ...tool, serverId: server.id });
      }
    } else if (server.tools_cache) {
      // Fall back to cached tools
      try {
        const cached = JSON.parse(server.tools_cache) as McpTool[];
        for (const tool of cached) {
          tools.push({ ...tool, serverId: server.id });
        }
      } catch {}
    }
  }

  return tools;
}

/** Call a tool on the appropriate MCP server */
export async function callTool(serverId: string, name: string, args: Record<string, unknown>) {
  const client = clients.get(serverId);
  if (!client?.connected) throw new Error(`MCP server ${serverId} not connected`);
  return client.callTool(name, args);
}

/** Disconnect all clients (for shutdown) */
export function disconnectAll() {
  for (const [id] of clients) disconnectServer(id);
}
