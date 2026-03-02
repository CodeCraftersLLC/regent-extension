-- Phase 3: Agent Runtime + MCP

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  system_prompt TEXT,
  mcp_servers TEXT, -- JSON array of MCP server IDs
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  input TEXT NOT NULL,
  output TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('stdio','sse','streamable-http')),
  config TEXT NOT NULL, -- JSON: { command, args, env } for stdio, { url } for sse/http
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('connected','disconnected','error')),
  tools_cache TEXT, -- JSON array of cached tool schemas
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_runs_workspace ON agent_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_mcp_workspace ON mcp_servers(workspace_id);
