import { Hono } from 'hono';
import { getDb } from '../../db/index.js';
import { newId } from '../../utils/id.js';
import { hashPassword, verifyPassword, signToken } from '../../utils/crypto.js';
import type { User } from '../../db/schema.js';

export const authRoutes = new Hono();

// POST /auth/register
authRoutes.post('/register', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  if (!username || !password || password.length < 8) {
    return c.json({ error: 'Username required, password min 8 chars' }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return c.json({ error: 'Username taken' }, 409);

  const id = newId();
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
    id, username, hashPassword(password)
  );

  // Auto-create default workspace
  const wsId = newId();
  db.prepare('INSERT INTO workspaces (id, name, owner_id) VALUES (?, ?, ?)').run(
    wsId, `${username}'s workspace`, id
  );
  db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(
    wsId, id, 'owner'
  );

  const token = await signToken({ sub: id, username });
  return c.json({ id, username, token, workspaceId: wsId }, 201);
});

// POST /auth/login
authRoutes.post('/login', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await signToken({ sub: user.id, username: user.username });
  return c.json({ id: user.id, username: user.username, token });
});

// POST /auth/token/generate — issue a long-lived API token for the extension
authRoutes.post('/token/generate', async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await signToken({ sub: user.id, username: user.username }, '365d');
  return c.json({ token, expiresIn: '365d' });
});
