import { createMiddleware } from 'hono/factory';
import { verifyToken } from '../../utils/crypto.js';
import { getDb } from '../../db/index.js';

export type AuthPayload = { userId: string; username: string };

// Augment Hono's context variables
declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthPayload;
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  try {
    const payload = await verifyToken(header.slice(7));

    // Validate payload types before trusting
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') {
      return c.json({ error: 'Malformed token payload' }, 401);
    }
    const userId = payload.sub;

    // Token revocation check: token's iat must be after user's updated_at
    if (typeof payload.iat === 'number') {
      const db = getDb();
      const user = db.prepare('SELECT updated_at FROM users WHERE id = ?').get(userId) as { updated_at: string } | undefined;
      if (user && payload.iat * 1000 < new Date(user.updated_at).getTime()) {
        return c.json({ error: 'Token has been revoked' }, 401);
      }
    }

    c.set('auth', { userId, username: payload.username });
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});
