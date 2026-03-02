// TypeScript types matching the SQLite schema

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  joined_at: string;
}

export interface Session {
  id: string;
  workspace_id: string;
  external_id: string | null;
  name: string | null;
  url: string | null;
  hostname: string | null;
  status: 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface RegentEvent {
  id: string;
  session_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  importance: 'high' | 'medium' | 'low';
  message_index: number | null;
  source_tab_id: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  content: string;
  role: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  workspace_id: string;
  session_id: string | null;
  event_id: string | null;
  content: string;
  embedding: Buffer | null;
  source_type: 'event' | 'note' | 'summary';
  created_at: string;
}

export interface ProviderCredential {
  user_id: string;
  provider: string;
  api_key: string;
  api_url: string | null;
  model: string | null;
  updated_at: string;
}
