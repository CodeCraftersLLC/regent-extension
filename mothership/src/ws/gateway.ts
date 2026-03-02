import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { verifyToken } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { bus } from '../events/bus.js';
import { getDb } from '../db/index.js';
import { addConnection, removeConnection } from './registry.js';
import { handleTabRegister } from './handlers/tabRegister.js';
import { handleEventsStore } from './handlers/eventsStore.js';
import { handleContextQuery } from './handlers/contextQuery.js';
import { handleAgentStart, handleAgentStop, cleanupAgentListeners } from './handlers/agentControl.js';
import { upsertProviderCredentials } from '../memory/embeddings.js';
import type { Connection } from './registry.js';

const HEARTBEAT_INTERVAL = 30_000;
const AUTH_TIMEOUT = 10_000; // 10s to send auth message

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

  // Accept upgrade without token in URL — auth happens via first message
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Support both: legacy URL token (for backwards compat) and Sec-WebSocket-Protocol header
    const urlToken = url.searchParams.get('token');
    const headerToken = req.headers['sec-websocket-protocol'];
    const tabId = url.searchParams.get('tabId') || `tab-${Date.now()}`;

    if (urlToken || headerToken) {
      // Authenticate immediately (legacy mode or header mode)
      const token = headerToken || urlToken!;
      verifyToken(token)
        .then(payload => {
          const subprotocols = headerToken ? [headerToken] : undefined;
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, {
              userId: payload.sub as string,
              username: payload.username as string,
              tabId,
              authenticated: true,
            });
          });
        })
        .catch(() => {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        });
    } else {
      // First-message auth mode
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, { userId: '', username: '', tabId, authenticated: false });
      });
    }
  });

  wss.on('connection', (ws: WebSocket, meta: { userId: string; username: string; tabId: string; authenticated: boolean }) => {
    // If not yet authenticated, wait for auth message
    if (!meta.authenticated) {
      const authTimer = setTimeout(() => {
        send(ws, { type: 'error', payload: { message: 'Auth timeout — send auth message within 10s' } });
        ws.close(4001, 'Auth timeout');
      }, AUTH_TIMEOUT);

      ws.once('message', async (raw) => {
        clearTimeout(authTimer);
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type !== 'auth' || !msg.payload?.token) {
            send(ws, { type: 'error', payload: { message: 'First message must be auth' } });
            ws.close(4002, 'Auth required');
            return;
          }
          const payload = await verifyToken(msg.payload.token);

          // Token revocation check
          const userId = payload.sub as string;
          if (payload.iat) {
            const db = getDb();
            const user = db.prepare('SELECT updated_at FROM users WHERE id = ?').get(userId) as { updated_at: string } | undefined;
            if (user && (payload.iat as number) * 1000 < new Date(user.updated_at).getTime()) {
              send(ws, { type: 'error', payload: { message: 'Token revoked' } });
              ws.close(4001, 'Token revoked');
              return;
            }
          }

          meta.userId = userId;
          meta.username = payload.username as string;
          meta.tabId = msg.payload.tabId || meta.tabId;
          meta.authenticated = true;
          setupConnection(ws, meta);
        } catch {
          send(ws, { type: 'error', payload: { message: 'Invalid token' } });
          ws.close(4001, 'Invalid token');
        }
      });
      return;
    }

    setupConnection(ws, meta);
  });

  function setupConnection(ws: WebSocket, meta: { userId: string; username: string; tabId: string }) {
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

    // Listen for notifications targeted at this user
    const onNotification = (data: { userId: string; notification: unknown }) => {
      if (data.userId === conn.userId) {
        send(ws, { type: 'notification', payload: data.notification });
      }
    };
    bus.on('notification:new', onNotification);

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
      bus.off('notification:new', onNotification);
      cleanupAgentListeners(conn);
      removeConnection(meta.userId, meta.tabId);
      log.info({ userId: meta.userId, tabId: meta.tabId }, 'WS disconnected');
    });
  }

  return wss;
}
