/**
 * Agent REST API — CRUD + run management.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { verifyMembership } from '../middleware/workspace.js';
import { createAgent, listAgents, getAgent, deleteAgent } from '../../agents/manager.js';
import { startRun, cancelRun, getRun, listRuns } from '../../agents/runtime.js';
import { checkRateLimit } from '../../utils/rateLimit.js';

export const agentRoutes = new Hono();
agentRoutes.use('*', authMiddleware);

/** GET /workspaces/:wsId/agents — viewer+ */
agentRoutes.get('/', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);
  return c.json(listAgents(ctx.wsId));
});

/** POST /workspaces/:wsId/agents — admin+ */
agentRoutes.post('/', async (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const { name, systemPrompt, mcpServers } = await c.req.json<{
    name: string; systemPrompt?: string; mcpServers?: string[];
  }>();
  if (!name || name.length > 256) return c.json({ error: 'name required (max 256 chars)' }, 400);
  if (systemPrompt && systemPrompt.length > 16384) return c.json({ error: 'systemPrompt too long (max 16KB)' }, 400);

  const agent = createAgent(ctx.wsId, { name, systemPrompt, mcpServers });
  return c.json(agent, 201);
});

/** DELETE /workspaces/:wsId/agents/:id — admin+ */
agentRoutes.delete('/:id', (c) => {
  const ctx = verifyMembership(c, 'admin');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const ok = deleteAgent(c.req.param('id'), ctx.wsId);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

/** POST /workspaces/:wsId/agents/:id/run — member+ */
agentRoutes.post('/:id/run', async (c) => {
  const ctx = verifyMembership(c, 'member');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const agent = getAgent(c.req.param('id'));
  if (!agent || agent.workspace_id !== ctx.wsId) return c.json({ error: 'Agent not found' }, 404);

  const { input, sessionId } = await c.req.json<{ input: string; sessionId?: string }>();
  if (!input || input.length > 32768) return c.json({ error: 'input required (max 32KB)' }, 400);

  if (!checkRateLimit(ctx.userId, 'agent_runs', 5)) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  const runId = await startRun({ agent, userId: ctx.userId, input, sessionId });
  return c.json({ runId, status: 'running' }, 201);
});

/** GET /workspaces/:wsId/agents/:id/runs — viewer+ */
agentRoutes.get('/:id/runs', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const agent = getAgent(c.req.param('id'));
  if (!agent || agent.workspace_id !== ctx.wsId) return c.json({ error: 'Agent not found' }, 404);

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100);
  return c.json(listRuns(agent.id, limit));
});

/** GET /workspaces/:wsId/agents/:id/runs/:rid — viewer+ */
agentRoutes.get('/:id/runs/:rid', (c) => {
  const ctx = verifyMembership(c);
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const run = getRun(c.req.param('rid'));
  if (!run || run.workspace_id !== ctx.wsId) return c.json({ error: 'Run not found' }, 404);
  return c.json(run);
});

/** POST /workspaces/:wsId/agents/:id/runs/:rid/cancel — member+ */
agentRoutes.post('/:id/runs/:rid/cancel', (c) => {
  const ctx = verifyMembership(c, 'member');
  if (!ctx) return c.json({ error: 'Not found' }, 404);

  const run = getRun(c.req.param('rid'));
  if (!run || run.agent_id !== c.req.param('id') || run.workspace_id !== ctx.wsId) {
    return c.json({ error: 'Run not found' }, 404);
  }

  const ok = cancelRun(c.req.param('rid'));
  if (!ok) return c.json({ error: 'Run already finished' }, 404);
  return c.json({ ok: true });
});
