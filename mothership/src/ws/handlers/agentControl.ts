/**
 * WebSocket handlers for agent control — start/stop agent runs, stream results.
 */

import { getDb } from '../../db/index.js';
import { getAgent } from '../../agents/manager.js';
import { startRun, cancelRun } from '../../agents/runtime.js';
import { bus } from '../../events/bus.js';
import { log } from '../../utils/logger.js';
import type { Connection } from '../registry.js';
import type { WebSocket } from 'ws';

interface AgentStartPayload {
  agentId: string;
  input: string;
  sessionId?: string;
}

interface AgentStopPayload {
  runId: string;
}

export function handleAgentStart(
  conn: Connection,
  payload: AgentStartPayload,
  send: (ws: WebSocket, msg: any) => void,
) {
  const { workspaceId, userId } = conn;
  if (!workspaceId) return;

  const { agentId, input } = payload;
  if (!agentId || !input) {
    send(conn.ws, { type: 'error', payload: { message: 'agentId and input required' } });
    return;
  }

  // Verify agent belongs to workspace
  const agent = getAgent(agentId);
  if (!agent || agent.workspace_id !== workspaceId) {
    send(conn.ws, { type: 'error', payload: { message: 'Agent not found' } });
    return;
  }

  // Start the run (async, returns immediately with runId)
  startRun({ agent, userId, input, sessionId: payload.sessionId })
    .then(runId => {
      send(conn.ws, { type: 'agent:started', payload: { runId, agentId } });

      // Set up bus listeners to stream results to this connection
      const onStream = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:stream', payload: data });
        if (data.done) {
          bus.off('agent:stream', onStream);
          bus.off('agent:tool_call', onToolCall);
          bus.off('agent:error', onError);
        }
      };
      const onToolCall = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:tool_call', payload: data });
      };
      const onError = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:error', payload: data });
        bus.off('agent:stream', onStream);
        bus.off('agent:tool_call', onToolCall);
        bus.off('agent:error', onError);
      };

      bus.on('agent:stream', onStream);
      bus.on('agent:tool_call', onToolCall);
      bus.on('agent:error', onError);

      // Auto-cleanup after 5 minutes (safety net)
      setTimeout(() => {
        bus.off('agent:stream', onStream);
        bus.off('agent:tool_call', onToolCall);
        bus.off('agent:error', onError);
      }, 5 * 60 * 1000);
    })
    .catch(err => {
      log.warn({ err, agentId }, 'Agent start failed');
      send(conn.ws, { type: 'agent:error', payload: { error: err.message } });
    });
}

export function handleAgentStop(
  conn: Connection,
  payload: AgentStopPayload,
  send: (ws: WebSocket, msg: any) => void,
) {
  const { runId } = payload;
  if (!runId) {
    send(conn.ws, { type: 'error', payload: { message: 'runId required' } });
    return;
  }

  const ok = cancelRun(runId);
  send(conn.ws, { type: 'agent:stopped', payload: { runId, ok } });
}
