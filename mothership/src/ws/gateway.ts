import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { verifyToken } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { bus } from '../events/bus.js';
import { addConnection, removeConnection, broadcastToWorkspace } from './registry.js';
import { handleTabRegister } from './handlers/tabRegister.js';
import { handleEventsStore } from './handlers/eventsStore.js';
import { handleContextQuery } from './handlers/contextQuery.js';
import { handleAgentStart, handleAgentStop } from './handlers/agentControl.js';
import { upsertProviderCredentials } from '../memory/embeddings.js';
import type { Connection } from './registry.js';

const HEARTBEAT_INTERVAL = 30_000;

interface WsEnvelope {
  type: string;
  payload?: unknown;
  correlationId?: string;
  ts?: number;
}

function send(ws: WebSocket, msg: WsEnvelope) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade with token auth
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) throw new Error('No token');

      const payload = await verifyToken(token);
      const userId = payload.sub as string;
      const username = payload.username as string;
      const tabId = url.searchParams.get('tabId') || `tab-${Date.now()}`;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, { userId, username, tabId });
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, meta: { userId: string; username: string; tabId: string }) => {
    const conn: Connection = { ws, userId: meta.userId, tabId: meta.tabId, workspaceId: null };
    addConnection(conn);
    log.info({ userId: meta.userId, tabId: meta.tabId }, 'WS connected');

    send(ws, { type: 'connected', payload: { userId: meta.userId, username: meta.username } });

    // Heartbeat
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL);

    // Listen for bus events → forward to this connection
    const onNewEvents = (data: { workspaceId: string; sessionId: string; events: unknown[]; sourceTabId: string }) => {
      if (conn.workspaceId === data.workspaceId && conn.tabId !== data.sourceTabId) {
        send(ws, { type: 'events:cross', payload: { sessionId: data.sessionId, events: data.events } });
      }
    };
    bus.on('events:new', onNewEvents);

    // Message dispatch
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsEnvelope;
        switch (msg.type) {
          case 'tab:register':
            handleTabRegister(conn, msg.payload as { workspaceId: string });
            break;
          case 'events:store':
            handleEventsStore(conn, msg.payload as any);
            break;
          case 'context:query':
            handleContextQuery(conn, { ...(msg.payload as any), correlationId: msg.correlationId }, send);
            break;
          case 'provider:credentials': {
            const creds = msg.payload as any;
            if (creds?.provider && creds?.apiKey) {
              upsertProviderCredentials(conn.userId, creds);
              send(ws, { type: 'provider:ack', correlationId: msg.correlationId });
            } else {
              send(ws, { type: 'error', payload: { message: 'provider and apiKey required' }, correlationId: msg.correlationId });
            }
            break;
          }
          case 'agent:start':
            handleAgentStart(conn, msg.payload as any, send);
            break;
          case 'agent:stop':
            handleAgentStop(conn, msg.payload as any, send);
            break;
          case 'ping':
            send(ws, { type: 'pong', ts: Date.now() });
            break;
          default:
            send(ws, { type: 'error', payload: { message: `Unknown type: ${msg.type}` } });
        }
      } catch (err) {
        log.warn({ err }, 'Invalid WS message');
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      bus.off('events:new', onNewEvents);
      removeConnection(meta.userId, meta.tabId);
      log.info({ userId: meta.userId, tabId: meta.tabId }, 'WS disconnected');
    });
  });

  return wss;
}
