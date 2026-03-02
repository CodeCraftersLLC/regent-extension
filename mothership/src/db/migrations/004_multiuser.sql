-- Phase 4: Multi-user collaboration + production hardening

-- Workspace invite/pairing codes
CREATE TABLE IF NOT EXISTS workspace_invites (
  code TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member','viewer')),
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rate limiting token bucket
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL, -- e.g. 'agent_runs', 'search', 'api'
  tokens INTEGER NOT NULL DEFAULT 100,
  max_tokens INTEGER NOT NULL DEFAULT 100,
  refill_rate INTEGER NOT NULL DEFAULT 10, -- tokens per minute
  last_refill TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, bucket)
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'event', 'agent_complete', 'member_joined'
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read);
