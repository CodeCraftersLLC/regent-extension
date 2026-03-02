/**
 * Agent Runtime — execute agent tasks with LLM + MCP tool access.
 * Streams response chunks via EventBus, persists results on completion.
 */

import { getDb } from '../db/index.js';
import { newId } from '../utils/id.js';
import { bus } from '../events/bus.js';
import { getProviderCredentials } from '../memory/embeddings.js';
import { getWorkspaceTools, callTool } from '../mcp/pool.js';
import { hybridSearch } from '../memory/search.js';
import { log } from '../utils/logger.js';
import type { Agent, AgentRun } from '../db/schema.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_OUTPUT_SIZE = 256 * 1024; // 256KB
const MAX_TOOL_RESULT_SIZE = 4096;   // 4KB per tool result
const ROUND_TIMEOUT = 120_000;       // 2 min per LLM round

/** Active runs: stores both controller and startTime */
const activeRuns = new Map<string, { controller: AbortController; startTime: number }>();

/** Runs already finalized — prevents double finishRun */
const finishedRuns = new Set<string>();

export interface RunOptions {
  agent: Agent;
  userId: string;
  input: string;
  sessionId?: string;
}

/** Start an agent run — streams chunks via bus, returns run ID */
export async function startRun(opts: RunOptions): Promise<string> {
  const { agent, userId, input, sessionId } = opts;
  const db = getDb();
  const runId = newId();
  const startTime = Date.now();

  db.prepare(`INSERT INTO agent_runs (id, agent_id, workspace_id, user_id, input, session_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'running')`)
    .run(runId, agent.id, agent.workspace_id, userId, input, sessionId ?? null);

  const controller = new AbortController();
  activeRuns.set(runId, { controller, startTime });

  executeRun(runId, opts, controller.signal, startTime).catch((err) => {
    log.warn({ err, runId }, 'Agent run failed');
    finishRun(runId, null, 'failed', startTime);
  });

  return runId;
}

/** Cancel a running agent */
export function cancelRun(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  activeRuns.delete(runId);
  finishRun(runId, null, 'cancelled', entry.startTime);
  return true;
}

/** Get run status */
export function getRun(runId: string): AgentRun | null {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as AgentRun | null;
}

/** List runs for an agent */
export function listRuns(agentId: string, limit = 20): AgentRun[] {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(agentId, limit) as AgentRun[];
}

// ── Internal execution ──

async function executeRun(runId: string, opts: RunOptions, signal: AbortSignal, startTime: number) {
  const { agent, userId, input } = opts;

  const creds = getProviderCredentials(userId);
  if (!creds) {
    bus.emit('agent:error', { runId, workspaceId: agent.workspace_id, error: 'No provider credentials configured' });
    finishRun(runId, null, 'failed', startTime);
    return;
  }

  // Gather context from memory
  let context = '';
  try {
    const memories = await hybridSearch(userId, agent.workspace_id, input, 5);
    if (memories.length) {
      context = '\n\nRelevant context from past sessions:\n' +
        memories.map(m => `- ${m.entry.content}`).join('\n');
    }
  } catch (err) {
    log.debug({ err, runId }, 'Memory search failed, continuing without context');
  }

  // Gather available MCP tools
  const mcpTools = getWorkspaceTools(agent.workspace_id);
  const toolDefs = mcpTools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  // Build messages
  const messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }> = [];
  const systemContent = (agent.system_prompt || 'You are a helpful agent.') + context;
  messages.push({ role: 'system', content: systemContent });
  messages.push({ role: 'user', content: input });

  // Determine API URL and model
  const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
    deepseek: { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openrouter: { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
    siliconflow: { url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  };
  const defaults = PROVIDER_DEFAULTS[creds.provider] ?? {};
  const baseUrl = (creds.api_url || defaults.url || '').replace(/\/+$/, '');
  const model = creds.model || defaults.model || 'deepseek-chat';

  let fullOutput = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) return;

    const body: Record<string, unknown> = { model, messages, stream: true };
    if (toolDefs.length > 0) body.tools = toolDefs;

    // Per-round timeout via combined signal
    const roundAbort = AbortSignal.any([signal, AbortSignal.timeout(ROUND_TIMEOUT)]);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.api_key}`,
      },
      body: JSON.stringify(body),
      signal: roundAbort,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      bus.emit('agent:error', { runId, workspaceId: agent.workspace_id, error: `LLM API ${res.status}: ${errText}` });
      finishRun(runId, fullOutput || null, 'failed', startTime);
      return;
    }

    const { content, toolCalls } = await parseStream(res, runId, agent.workspace_id, roundAbort);
    fullOutput += content;

    // Cap total output size
    if (fullOutput.length > MAX_OUTPUT_SIZE) {
      fullOutput = fullOutput.slice(0, MAX_OUTPUT_SIZE) + '\n[output truncated]';
      break;
    }

    if (!toolCalls.length) break;

    messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });

    // Execute tool calls
    for (const tc of toolCalls) {
      if (signal.aborted) return;

      const toolName = tc.function.name;

      // Safe JSON parse for tool arguments
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        const errMsg = `Invalid tool arguments JSON for ${toolName}`;
        log.debug({ runId, toolName, raw: tc.function.arguments }, errMsg);
        messages.push({ role: 'tool', content: `Error: ${errMsg}`, tool_call_id: tc.id });
        continue;
      }

      const mcpTool = mcpTools.find(t => t.name === toolName);
      let toolResult: string;

      if (mcpTool) {
        try {
          const result = await callTool(mcpTool.serverId, toolName, toolArgs);
          toolResult = result.content?.map((c: any) => c.text || '').join('\n') || 'Success';
          // Truncate oversized tool results
          if (toolResult.length > MAX_TOOL_RESULT_SIZE) {
            toolResult = toolResult.slice(0, MAX_TOOL_RESULT_SIZE) + '\n[truncated]';
          }
          bus.emit('agent:tool_call', {
            runId, workspaceId: agent.workspace_id,
            tool: toolName, input: toolArgs, output: toolResult,
          });
        } catch (err: any) {
          toolResult = `Error: ${err.message}`;
          bus.emit('agent:tool_call', {
            runId, workspaceId: agent.workspace_id,
            tool: toolName, input: toolArgs, output: toolResult, error: true,
          });
        }
      } else {
        toolResult = `Unknown tool: ${toolName}`;
      }

      messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id });
    }
  }

  activeRuns.delete(runId);
  finishRun(runId, fullOutput, 'completed', startTime);

  bus.emit('agent:stream', { runId, workspaceId: agent.workspace_id, chunk: '', done: true, result: fullOutput });
}

/** Parse SSE stream, emit chunks via bus */
async function parseStream(
  res: Response,
  runId: string,
  workspaceId: string,
  signal: AbortSignal,
): Promise<{ content: string; toolCalls: any[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: any[] = [];

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let sepIdx;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const dataLines = event.split('\n').filter(l => l.startsWith('data: '));
        const payload = dataLines.map(l => l.slice(6)).join('');

        if (payload === '[DONE]') continue;

        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
            bus.emit('agent:stream', { runId, workspaceId, chunk: delta.content, done: false });
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        } catch (err) {
          log.debug({ err, runId, payload: payload.slice(0, 200) }, 'SSE chunk parse error');
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, toolCalls: toolCalls.filter(Boolean) };
}

/** Update run record in DB — guarded against double invocation */
function finishRun(runId: string, output: string | null, status: AgentRun['status'], startTime: number) {
  if (finishedRuns.has(runId)) return;
  finishedRuns.add(runId);
  // Evict from set after 60s to prevent unbounded growth
  setTimeout(() => finishedRuns.delete(runId), 60_000);

  const db = getDb();
  const duration = startTime ? Date.now() - startTime : null;
  db.prepare(`UPDATE agent_runs SET output = ?, status = ?, finished_at = datetime('now'), duration_ms = ? WHERE id = ? AND status = 'running'`)
    .run(output, status, duration, runId);
  activeRuns.delete(runId);
}
