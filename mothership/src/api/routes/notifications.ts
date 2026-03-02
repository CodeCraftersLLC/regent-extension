/**
 * Notifications API — list, mark read, and manage notifications.
 */

import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { authMiddleware } from '../middleware/auth.js';
import { bus } from '../../events/bus.js';

export const notificationRoutes = new Hono();
notificationRoutes.use('*', authMiddleware);

/** GET /notifications — list with offset + limit pagination */
notificationRoutes.get('/', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  const unreadOnly = c.req.query('unread') === 'true';

  const sql = unreadOnly
    ? 'SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';

  return c.json(db.prepare(sql).all(userId, limit, offset));
});

/** POST /notifications/:id/read — mark as read */
notificationRoutes.post('/:id/read', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?')
    .run(c.req.param('id'), userId);
  return c.json({ ok: true });
});

/** POST /notifications/read-all — mark all as read */
notificationRoutes.post('/read-all', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  return c.json({ ok: true });
});

/** GET /notifications/count — unread count */
notificationRoutes.get('/count', (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0')
    .get(userId) as { count: number };
  return c.json({ unread: row.count });
});

/** Create a notification for a user (internal helper) */
export function createNotification(userId: string, workspaceId: string, type: string, title: string, body?: string) {
  const db = getDb();
  const id = newId();
  db.prepare(`INSERT INTO notifications (id, user_id, workspace_id, type, title, body) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, userId, workspaceId, type, title, body ?? null);

  bus.emit('notification:new', { userId, notification: { id, type, title, body, workspaceId } });
}

/** Notify all workspace members (except excludeUserId) */
export function notifyWorkspaceMembers(workspaceId: string, type: string, title: string, body?: string, excludeUserId?: string) {
  const db = getDb();
  const members = db.prepare('SELECT user_id FROM workspace_members WHERE workspace_id = ?')
    .all(workspaceId) as { user_id: string }[];

  for (const { user_id } of members) {
    if (user_id === excludeUserId) continue;
    createNotification(user_id, workspaceId, type, title, body);
  }
}
