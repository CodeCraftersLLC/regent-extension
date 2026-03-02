import { createMiddleware } from 'hono/factory';
import { verifyToken } from '../../utils/crypto.js';

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
    c.set('auth', { userId: payload.sub as string, username: payload.username as string });
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});
