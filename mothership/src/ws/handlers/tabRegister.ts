import { getDb } from '../../db/index.js';
import type { Connection } from '../registry.js';

/**
 * Handle tab:register — extension tab announces itself and its workspace.
 * Verifies the user is a member of the workspace before allowing registration.
 */
export function handleTabRegister(conn: Connection, payload: { workspaceId: string }) {
  const { workspaceId } = payload;
  if (!workspaceId) return;

  const db = getDb();
  const member = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, conn.userId);
  if (!member) return;

  conn.workspaceId = workspaceId;
}
