/**
 * MCP Client — lightweight wrapper for MCP server communication.
 * Supports stdio (subprocess) and HTTP/SSE transports.
 * No dependency on @modelcontextprotocol/sdk — uses raw JSON-RPC 2.0.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';

/** Allowed MCP commands — only bare names, no paths allowed */
const ALLOWED_COMMANDS = new Set([
  'npx', 'node', 'python', 'python3', 'uvx', 'docker',
  'mcp-server-fetch', 'mcp-server-filesystem', 'mcp-server-github',
  'mcp-server-postgres', 'mcp-server-sqlite', 'mcp-server-memory',
]);

/** Blocked interpreter flags that enable arbitrary code execution */
const BLOCKED_FLAGS = new Set(['-e', '--eval', '-c', '--command', '--exec', '-i', '--interactive']);

/** Env vars that cannot be overridden (privilege escalation prevention) */
const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'HOME', 'USER',
]);

/** Block requests to private/internal IP ranges (SSRF protection) */
function validateUrl(url: string) {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error('Blocked: credentials in URL not allowed');
  }

  // Comprehensive private IP check including IPv6
  if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|localhost$|::1$|\[::1\]$|fe80:|fc00:|fd00:|0x|0[0-7])/i.test(hostname)) {
    throw new Error(`Blocked: private/internal address ${hostname}`);
  }
  // Block cloud metadata hostnames
  if (/^(metadata\.google\.internal|instance-data|169\.254\.169\.254)$/i.test(hostname)) {
    throw new Error(`Blocked: cloud metadata address ${hostname}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Blocked: unsupported protocol ${parsed.protocol}`);
  }
}

const REQUEST_TIMEOUT = 30_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

export interface McpClientConfig {
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export class McpClient {
  private config: McpClientConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private _tools: McpTool[] = [];
  private _connected = false;

  constructor(config: McpClientConfig) {
    this.config = config;
  }

  get connected() { return this._connected; }
  get tools() { return this._tools; }

  /** Connect to MCP server */
  async connect(): Promise<McpTool[]> {
    if (this.config.transport === 'stdio') return this.connectStdio();
    return this.connectHttp();
  }

  /** Disconnect from MCP server */
  disconnect() {
    if (this.process) {
      const proc = this.process;
      proc.kill('SIGTERM');
      // Escalate to SIGKILL after 5s if process doesn't exit
      const forceKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      proc.once('exit', () => clearTimeout(forceKill));
      this.process = null;
    }
    this._connected = false;
    this.pending.forEach(p => p.reject(new Error('Disconnected')));
    this.pending.clear();
  }

  /** Call an MCP tool */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return await this.request('tools/call', { name, arguments: args }) as McpToolResult;
  }

  /** List tools from the server */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    this._tools = (result?.tools || []) as McpTool[];
    return this._tools;
  }

  // ── stdio transport ──

  private async connectStdio(): Promise<McpTool[]> {
    const { command, args = [], env } = this.config;
    if (!command) throw new Error('stdio transport requires command');

    // Security: reject absolute/relative paths — only bare command names via PATH resolution
    if (command.includes('/') || command.includes('\\')) {
      throw new Error('Blocked: absolute/relative paths not allowed — use bare command names only');
    }
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`Blocked: command '${command}' not in allowlist. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`);
    }

    // Security: block dangerous interpreter flags that allow arbitrary code execution
    for (const arg of args) {
      if (BLOCKED_FLAGS.has(arg)) {
        throw new Error(`Blocked: dangerous flag '${arg}' not allowed in MCP args`);
      }
    }

    // Security: strip blocked env vars
    const safeEnv: Record<string, string> = {};
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (!BLOCKED_ENV_KEYS.has(k.toUpperCase())) safeEnv[k] = v;
        else log.warn({ key: k }, 'MCP: blocked env var override');
      }
    }

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...safeEnv },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
      log.debug({ stderr: chunk.toString().trim() }, 'MCP stderr');
    });

    this.process.on('exit', (code) => {
      log.info({ code }, 'MCP process exited');
      this._connected = false;
    });

    // Initialize
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'regent-mothership', version: '0.1.0' },
    });

    this.notify('notifications/initialized', {});
    this._connected = true;
    return this.listTools();
  }

  // ── HTTP/SSE transport ──

  private async connectHttp(): Promise<McpTool[]> {
    const { url } = this.config;
    if (!url) throw new Error('HTTP transport requires url');

    // Security: block private/internal URLs
    validateUrl(url);

    this._connected = true;

    await this.httpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'regent-mothership', version: '0.1.0' },
    });

    return this.listTools();
  }

  // ── JSON-RPC helpers ──

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.config.transport !== 'stdio') return this.httpRequest(method, params);

    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) return reject(new Error('Not connected'));

      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify(req) + '\n');

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT);
    });
  }

  private async httpRequest(method: string, params: Record<string, unknown>): Promise<any> {
    // Re-validate URL on every request (defense-in-depth against config mutation)
    validateUrl(this.config.url!);

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const res = await fetch(this.config.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!res.ok) throw new Error(`MCP HTTP error: ${res.status}`);

    const response = await res.json() as JsonRpcResponse;
    if (response.error) throw new Error(`MCP error: ${response.error.message}`);
    return response.result;
  }

  private notify(method: string, params: Record<string, unknown>) {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id != null && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message));
          else handler.resolve(msg.result);
        }
      } catch {
        log.debug({ line }, 'Non-JSON MCP output');
      }
    }
  }
}
