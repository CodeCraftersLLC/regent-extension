/**
 * Workspace invite API — generate and redeem pairing codes.
 */

import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { nanoid } from 'nanoid';
import type { WorkspaceInvite } from '../../db/schema.js';

export const inviteRoutes = new Hono();
inviteRoutes.use('*', authMiddleware);

function verifyMembership(c: any, requiredRole?: string) {
  const wsId = c.req.param('wsId');
  const { userId } = c.get('auth');
  const db = getDb();
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(wsId, userId) as { role: string } | undefined;
  if (!member) return null;
  if (requiredRole && member.role !== 'owner' && member.role !== requiredRole) return null;
  return { wsId, userId, db, role: member.role };
}

/** POST /workspaces/:wsId/invites — generate invite code (owner/admin only) */
inviteRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found or insufficient permissions' }, 404);

  const { role, maxUses, expiresIn } = await c.req.json<{
    role?: 'admin' | 'member' | 'viewer';
    maxUses?: number;
    expiresIn?: number; // hours
  }>();

  // Validate role against allowed values
  const validRoles = ['admin', 'member', 'viewer'] as const;
  const inviteRole = validRoles.includes(role as any) ? role! : 'member';
  const uses = Math.max(1, Math.min(maxUses || 1, 100));

  const code = nanoid(12);
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 60 * 60 * 1000).toISOString()
    : null;

  ctx.db.prepare(`INSERT INTO workspace_invites (code, workspace_id, created_by, role, max_uses, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(code, ctx.wsId, ctx.userId, inviteRole, uses, expiresAt);

  return c.json({ code, role: inviteRole, maxUses: uses, expiresAt }, 201);
});

/** POST /auth/pair — redeem an invite code (appended to auth routes) */
export async function redeemInvite(c: any) {
  const { userId } = c.get('auth');
  const { code } = await c.req.json() as { code: string };
  if (!code) return c.json({ error: 'code required' }, 400);

  const db = getDb();

  // Atomic: validate + redeem inside a single transaction to prevent TOCTOU race
  const result = db.transaction(() => {
    const invite = db.prepare('SELECT * FROM workspace_invites WHERE code = ?').get(code) as WorkspaceInvite | null;
    if (!invite) return { error: 'Invalid invite code', status: 404 };
    if (invite.uses >= invite.max_uses) return { error: 'Invite code exhausted', status: 410 };
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return { error: 'Invite expired', status: 410 };

    const existing = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(invite.workspace_id, userId);
    if (existing) return { error: 'Already a member', status: 409 };

    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
      .run(invite.workspace_id, userId, invite.role);
    db.prepare('UPDATE workspace_invites SET uses = uses + 1 WHERE code = ?').run(code);

    db.prepare('INSERT INTO audit_log (id, user_id, action, resource_type, resource_id) VALUES (?, ?, ?, ?, ?)')
      .run(newId(), userId, 'workspace_joined', 'workspace', invite.workspace_id);

    return { workspaceId: invite.workspace_id, role: invite.role };
  })();

  if ('error' in result) return c.json({ error: result.error }, result.status as any);
  return c.json(result);
}

/** GET /workspaces/:wsId/invites — list active invites */
inviteRoutes.get('/', (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const invites = ctx.db.prepare(
    'SELECT code, role, max_uses, uses, expires_at, created_at FROM workspace_invites WHERE workspace_id = ? ORDER BY created_at DESC'
  ).all(ctx.wsId);

  return c.json(invites);
});

/** DELETE /workspaces/:wsId/invites/:code — revoke invite */
inviteRoutes.delete('/:code', (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const result = ctx.db.prepare('DELETE FROM workspace_invites WHERE code = ? AND workspace_id = ?')
    .run(c.req.param('code'), ctx.wsId);
  if (result.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});
