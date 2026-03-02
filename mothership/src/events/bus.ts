import { EventEmitter } from 'node:events';

/**
 * Singleton event bus for broadcasting DB changes to WebSocket subscribers.
 * Pattern borrowed from OpenClaw's architecture.
 *
 * Events:
 *   'events:new'   → { workspaceId, sessionId, events[] }
 *   'session:open'  → { workspaceId, session }
 *   'session:close' → { workspaceId, sessionId }
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(1000); // Support many concurrent WS connections
  }
}

export const bus = new Bus();
