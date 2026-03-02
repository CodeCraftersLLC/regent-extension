import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { hashPassword, verifyPassword, signToken } from '../../utils/crypto.js';
import { checkRateLimit } from '../../utils/rateLimit.js';
import { authMiddleware } from '../middleware/auth.js';
import type { User } from '../../db/schema.js';

export const authRoutes = new Hono();

const USERNAME_RE = /^[a-zA-Z0-9_\-]{3,64}$/;

/** Shared credential verification — returns User or null */
function authenticate(username: string, password: string): User | null {
  if (!username || !password) return null;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return user;
}

// POST /auth/register — rate limited
authRoutes.post('/register', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();

  if (!username || !USERNAME_RE.test(username)) {
    return c.json({ error: 'Username must be 3-64 alphanumeric/underscore/hyphen characters' }, 400);
  }
  if (!password || password.length < 8) {
    return c.json({ error: 'Password min 8 chars' }, 400);
  }

  // Rate limit by IP (use 'register' bucket, cost 10 per registration)
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(`ip:${ip}`, 'auth', 10)) {
    return c.json({ error: 'Too many requests, try again later' }, 429);
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return c.json({ error: 'Username taken' }, 409);

  const id = newId();
  const wsId = newId();

  // Atomic: create user + default workspace + membership in one transaction
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
      id, username, hashPassword(password)
    );
    db.prepare('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)').run(
      wsId, `${username}'s workspace`, id
    );
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(
      wsId, id, 'owner'
    );
  })();

  const token = await signToken({ sub: id, username });
  return c.json({ id, username, token, workspaceId: wsId }, 201);
});

// POST /auth/login — rate limited
authRoutes.post('/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(`ip:${ip}`, 'auth', 3)) {
    return c.json({ error: 'Too many login attempts, try again later' }, 429);
  }

  const user = authenticate(username, password);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);

  const token = await signToken({ sub: user.id, username: user.username });
  return c.json({ id: user.id, username: user.username, token });
});

// POST /auth/token/generate — extension API token (30d, refreshable)
authRoutes.post('/token/generate', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();

  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(`ip:${ip}`, 'auth', 3)) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  const user = authenticate(username, password);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);

  const token = await signToken({ sub: user.id, username: user.username }, '30d');

  // Update token_issued_after for revocation support
  const db = getDb();
  db.prepare("UPDATE users SET updated_at = datetime('now') WHERE id = ?").run(user.id);

  return c.json({ token, expiresIn: '30d' });
});

// POST /auth/revoke — invalidate all existing tokens by updating updated_at
authRoutes.post('/revoke', authMiddleware, (c) => {
  const { userId } = c.get('auth');
  const db = getDb();
  db.prepare("UPDATE users SET updated_at = datetime('now') WHERE id = ?").run(userId);
  return c.json({ ok: true, message: 'All existing tokens invalidated' });
});
