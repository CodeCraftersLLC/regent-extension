import type { WebSocket } from 'ws';

export interface Connection {
  ws: WebSocket;
  userId: string;
  tabId: string;
  workspaceId: string | null;
}

/** userId → Map<tabId, Connection> */
const connections = new Map<string, Map<string, Connection>>();

export function addConnection(conn: Connection) {
  let userConns = connections.get(conn.userId);
  if (!userConns) {
    userConns = new Map();
    connections.set(conn.userId, userConns);
  }
  userConns.set(conn.tabId, conn);
}

export function removeConnection(userId: string, tabId: string) {
  const userConns = connections.get(userId);
  if (!userConns) return;
  userConns.delete(tabId);
  if (userConns.size === 0) connections.delete(userId);
}

export function getConnection(userId: string, tabId: string): Connection | undefined {
  return connections.get(userId)?.get(tabId);
}

/** Get all connections for a workspace (across all users) */
export function getWorkspaceConnections(workspaceId: string): Connection[] {
  const result: Connection[] = [];
  for (const userConns of connections.values()) {
    for (const conn of userConns.values()) {
      if (conn.workspaceId === workspaceId) result.push(conn);
    }
  }
  return result;
}

/** Broadcast a message to all tabs in a workspace, optionally excluding a tabId */
export function broadcastToWorkspace(workspaceId: string, message: object, excludeTabId?: string) {
  const payload = JSON.stringify(message);
  for (const conn of getWorkspaceConnections(workspaceId)) {
    if (conn.tabId !== excludeTabId && conn.ws.readyState === 1) {
      try { conn.ws.send(payload); } catch { /* connection already closing */ }
    }
  }
}
