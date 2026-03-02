-- Phase 2: Memory & Context — FTS5 + vector embeddings

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  source_type TEXT NOT NULL DEFAULT 'event' CHECK(source_type IN ('event','note','summary')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Trigger: auto-populate FTS on insert
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Trigger: auto-update FTS on update (FTS5 requires delete+insert, not UPDATE)
CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF content ON memory_entries BEGIN
  DELETE FROM memory_fts WHERE rowid = OLD.rowid;
  INSERT INTO memory_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- Trigger: auto-delete FTS on delete
CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_entries BEGIN
  DELETE FROM memory_fts WHERE rowid = OLD.rowid;
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_event ON memory_entries(event_id);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);

-- Provider credentials table (encrypted, per-user session-scoped)
CREATE TABLE IF NOT EXISTS provider_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  api_key TEXT NOT NULL,
  api_url TEXT,
  model TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
