import type { Connection } from '../registry.js';

/**
 * Handle tab:register — extension tab announces itself and its workspace.
 */
export function handleTabRegister(conn: Connection, payload: { workspaceId: string }) {
  conn.workspaceId = payload.workspaceId;
}
