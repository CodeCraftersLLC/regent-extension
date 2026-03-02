/**
 * MCP Client — lightweight wrapper for MCP server communication.
 * Supports stdio (subprocess) and HTTP/SSE transports.
 * No dependency on @modelcontextprotocol/sdk — uses raw JSON-RPC 2.0.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';

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
    if (this.config.transport === 'stdio') {
      return this.connectStdio();
    }
    return this.connectHttp();
  }

  /** Disconnect from MCP server */
  disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._connected = false;
    this.pending.forEach(p => p.reject(new Error('Disconnected')));
    this.pending.clear();
  }

  /** Call an MCP tool */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    return result as McpToolResult;
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

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
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

    // Send initialized notification
    this.notify('notifications/initialized', {});

    this._connected = true;
    return this.listTools();
  }

  // ── HTTP/SSE transport ──

  private async connectHttp(): Promise<McpTool[]> {
    const { url } = this.config;
    if (!url) throw new Error('HTTP transport requires url');

    // For HTTP transport, we use direct JSON-RPC over HTTP POST
    this._connected = true;

    // Initialize
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

      // Timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private async httpRequest(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const res = await fetch(this.config.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
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
