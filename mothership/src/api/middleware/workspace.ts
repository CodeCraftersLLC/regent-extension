/**
 * Shared workspace membership verification with role-based access control.
 * Replaces 6 duplicate verifyMembership functions across route files.
 */

import { getDb } from '../../db/index.js';

const ROLE_HIERARCHY: Record<string, number> = { owner: 40, admin: 30, member: 20, viewer: 10 };

export interface WorkspaceContext {
  wsId: string;
  userId: string;
  role: string;
  db: ReturnType<typeof getDb>;
}

/**
 * Verify the authenticated user is a member of the workspace.
 * Optionally enforce a minimum role level.
 *
 * @param c - Hono context (uses `c.req.param('wsId')` and `c.get('auth')`)
 * @param minRole - Minimum role required (default: 'viewer' — any member)
 * @returns WorkspaceContext or null if unauthorized
 */
export function verifyMembership(c: any, minRole: string = 'viewer'): WorkspaceContext | null {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();

  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(wsId, userId) as { role: string } | undefined;
  if (!member) return null;

  // Check role hierarchy: owner > admin > member > viewer
  const userLevel = ROLE_HIERARCHY[member.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;
  if (userLevel < requiredLevel) return null;

  return { wsId, userId, role: member.role, db };
}
