/**
 * Agent Runtime — execute agent tasks with LLM + MCP tool access.
 * Uses Mastra Agent as the inner execution engine for LLM streaming + tool calling.
 * Our orchestration shell (DB writes, bus events, safety limits, run tracking) wraps it.
 */

import { Agent as MastraAgent } from '@mastra/core/agent';
import { getDb } from '../db/index.js';
import { newId } from '../utils/id.js';
import { bus } from '../events/bus.js';
import { getProviderCredentials } from '../memory/embeddings.js';
import { getWorkspaceTools } from '../mcp/pool.js';
import { hybridSearch } from '../memory/search.js';
import { log } from '../utils/logger.js';
import { resolveModel } from './modelResolver.js';
import { bridgeWorkspaceTools } from './mcpBridge.js';
import type { Agent, AgentRun } from '../db/schema.js';

const MAX_TOOL_ROUNDS = 10;
const MAX_OUTPUT_SIZE = 256 * 1024; // 256KB

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

// ── Internal execution (powered by Mastra Agent) ──

async function executeRun(runId: string, opts: RunOptions, signal: AbortSignal, startTime: number) {
  const { agent, userId, input } = opts;

  const creds = getProviderCredentials(userId);
  if (!creds) {
    bus.emit('agent:error', { runId, workspaceId: agent.workspace_id, error: 'No provider credentials configured' });
    finishRun(runId, null, 'failed', startTime);
    return;
  }

  // Gather RAG context from memory
  let contextBlock = '';
  try {
    const memories = await hybridSearch(userId, agent.workspace_id, input, 5);
    if (memories.length) {
      contextBlock = '\n\nRelevant context from past sessions:\n' +
        memories.map(m => `- ${m.entry.content}`).join('\n');
    }
  } catch (err) {
    log.debug({ err, runId }, 'Memory search failed, continuing without context');
  }

  // Bridge MCP tools through our security layer → Mastra tools
  const mcpTools = getWorkspaceTools(agent.workspace_id);
  const tools = bridgeWorkspaceTools(mcpTools);

  // Create Mastra agent for this run
  const mastraAgent = new MastraAgent({
    id: `run-${runId}`,
    name: agent.name || `Agent ${agent.id}`,
    instructions: (agent.system_prompt || 'You are a helpful agent.') + contextBlock,
    model: resolveModel(creds),
    tools,
  });

  let fullOutput = '';

  try {
    const result = await mastraAgent.stream(input, {
      maxSteps: MAX_TOOL_ROUNDS,
      abortSignal: signal,
    });

    // Stream text chunks → bus
    const reader = result.textStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fullOutput += value;
        bus.emit('agent:stream', { runId, workspaceId: agent.workspace_id, chunk: value, done: false });

        if (fullOutput.length > MAX_OUTPUT_SIZE) {
          fullOutput = fullOutput.slice(0, MAX_OUTPUT_SIZE) + '\n[output truncated]';
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit tool call events (resolved after stream completes)
    try {
      const toolResults = await result.toolResults;
      for (const tr of toolResults) {
        bus.emit('agent:tool_call', {
          runId, workspaceId: agent.workspace_id,
          tool: tr.payload.toolName, input: tr.payload.args, output: tr.payload.result,
        });
      }
    } catch (err) {
      log.debug({ err, runId }, 'Tool results extraction failed');
    }
  } catch (err: any) {
    if (signal.aborted) return; // Cancelled — finishRun already called by cancelRun
    bus.emit('agent:error', { runId, workspaceId: agent.workspace_id, error: err.message || String(err) });
    finishRun(runId, fullOutput || null, 'failed', startTime);
    return;
  }

  activeRuns.delete(runId);
  finishRun(runId, fullOutput, 'completed', startTime);
  bus.emit('agent:stream', { runId, workspaceId: agent.workspace_id, chunk: '', done: true, result: fullOutput });
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
