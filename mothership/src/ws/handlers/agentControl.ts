/**
 * WebSocket handlers for agent control — start/stop agent runs, stream results.
 */

import { getAgent } from '../../agents/manager.js';
import { startRun, cancelRun, getRun } from '../../agents/runtime.js';
import { bus } from '../../events/bus.js';
import { log } from '../../utils/logger.js';
import type { Connection } from '../registry.js';
import type { WebSocket } from 'ws';

interface AgentStartPayload { agentId: string; input: string; sessionId?: string; }
interface AgentStopPayload { runId: string; }

type SendFn = (ws: WebSocket, msg: any) => void;

/** Track bus listeners per connection for cleanup on disconnect */
const connectionListeners = new Map<string, Array<{ event: string; fn: (...args: any[]) => void }>>();

function connKey(conn: Connection) { return `${conn.userId}:${conn.tabId}`; }

function trackListener(conn: Connection, event: string, fn: (...args: any[]) => void) {
  const key = connKey(conn);
  if (!connectionListeners.has(key)) connectionListeners.set(key, []);
  connectionListeners.get(key)!.push({ event, fn });
  bus.on(event, fn);
}

function untrackListener(conn: Connection, fn: (...args: any[]) => void) {
  const key = connKey(conn);
  const arr = connectionListeners.get(key);
  if (!arr) return;
  const idx = arr.findIndex(l => l.fn === fn);
  if (idx !== -1) {
    bus.off(arr[idx].event, arr[idx].fn);
    arr.splice(idx, 1);
  }
}

/** Clean up all agent bus listeners for a connection — call from gateway on WS close */
export function cleanupAgentListeners(conn: Connection) {
  const key = connKey(conn);
  const listeners = connectionListeners.get(key);
  if (!listeners) return;
  for (const { event, fn } of listeners) bus.off(event, fn);
  connectionListeners.delete(key);
}

export function handleAgentStart(conn: Connection, payload: AgentStartPayload, send: SendFn) {
  const { workspaceId, userId } = conn;
  if (!workspaceId) return;

  const { agentId, input } = payload;
  if (!agentId || !input) {
    send(conn.ws, { type: 'error', payload: { message: 'agentId and input required' } });
    return;
  }

  const agent = getAgent(agentId);
  if (!agent || agent.workspace_id !== workspaceId) {
    send(conn.ws, { type: 'error', payload: { message: 'Agent not found' } });
    return;
  }

  startRun({ agent, userId, input, sessionId: payload.sessionId })
    .then(runId => {
      send(conn.ws, { type: 'agent:started', payload: { runId, agentId } });

      let safetyTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        // Clear the safety timeout
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        // Remove from both bus AND connectionListeners tracking
        untrackListener(conn, onStream);
        untrackListener(conn, onToolCall);
        untrackListener(conn, onError);
      };

      const onStream = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:stream', payload: data });
        if (data.done) cleanup();
      };
      const onToolCall = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:tool_call', payload: data });
      };
      const onError = (data: any) => {
        if (data.runId !== runId) return;
        send(conn.ws, { type: 'agent:error', payload: data });
        cleanup();
      };

      trackListener(conn, 'agent:stream', onStream);
      trackListener(conn, 'agent:tool_call', onToolCall);
      trackListener(conn, 'agent:error', onError);

      // Safety net: auto-cleanup after 5 minutes (clearable)
      safetyTimer = setTimeout(cleanup, 5 * 60 * 1000);
    })
    .catch(err => {
      log.warn({ err, agentId }, 'Agent start failed');
      send(conn.ws, { type: 'agent:error', payload: { error: err.message } });
    });
}

export function handleAgentStop(conn: Connection, payload: AgentStopPayload, send: SendFn) {
  const { runId } = payload;
  if (!runId) {
    send(conn.ws, { type: 'error', payload: { message: 'runId required' } });
    return;
  }

  // Verify run belongs to this user's workspace
  const run = getRun(runId);
  if (!run || run.workspace_id !== conn.workspaceId) {
    send(conn.ws, { type: 'error', payload: { message: 'Run not found' } });
    return;
  }

  const ok = cancelRun(runId);
  send(conn.ws, { type: 'agent:stopped', payload: { runId, ok } });
}
