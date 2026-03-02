/**
 * RegentOrchestrator — Top-level coordinator
 *
 * Manages sidecar lifecycle, aggregates cross-session state,
 * and coordinates the sidebar UI. Entry point for the regent system.
 */

import { RegentDetector } from './RegentDetector';
import { RegentSidecar } from './RegentSidecar';
import { RegentAIService } from './RegentAIService';
import { RegentSidebar } from './RegentSidebar';

const META_SUMMARY_INTERVAL = 120_000; // 2 minutes

class RegentOrchestratorClass {
  constructor() {
    this.detector = new RegentDetector();
    this.aiService = new RegentAIService();
    this.sidebar = new RegentSidebar();
    this.sidecars = new Map(); // sessionId → RegentSidecar
    this._metaTimer = null;
    this._initialized = false;
  }

  /** Initialize the regent system */
  async init() {
    if (this._initialized) return;
    this._initialized = true;

    console.log('[Regent] Initializing orchestrator on', location.hostname);

    // Mount sidebar UI
    this.sidebar.mount();

    // Load stored selectors
    await this.detector.loadSelectors();

    // Try to detect existing sessions
    let sessions = this.detector.detectSessions();

    // Auto-calibrate via AI if detection failed
    if (sessions.length === 0) {
      try {
        const selectors = await this.detector.autoCalibrate(this.aiService);
        if (selectors) sessions = this.detector.detectSessions();
      } catch (err) {
        console.warn('[Regent] Auto-calibrate failed:', err.message);
      }
    }

    if (sessions.length > 0) {
      for (const sessionEl of sessions) {
        const id = this.detector.getSessionId(sessionEl);
        this._createSidecar(id, sessionEl);
      }
    } else {
      this.sidebar.showCalibration(
        () => this._runCalibration(),
        () => this._runAutoCalibration(),
      );
    }

    // Start observing for dynamic session changes
    this.detector.startObserving({
      onSessionFound: (id, el) => this._createSidecar(id, el),
      onSessionLost: id => this._destroySidecar(id),
      onNewMessages: (id, newMsgs) => this._onNewMessages(id, newMsgs),
    });

    // Periodic meta-summary
    this._metaTimer = setInterval(() => this._generateMetaSummary(), META_SUMMARY_INTERVAL);

    // Listen for mothership events (cross-session from other tabs/devices)
    this._mothershipListener = (msg) => {
      if (msg.type === 'mothershipEvent') this._onMothershipEvent(msg.data);
      if (msg.type === 'mothershipStatus') this.sidebar.setConnectionStatus(msg.status);
    };
    chrome.runtime.onMessage.addListener(this._mothershipListener);

    // Check initial mothership status
    chrome.runtime.sendMessage({ action: 'mothershipStatus' }, (res) => {
      this.sidebar.setConnectionStatus(res?.connected ? 'connected' : 'disconnected');
    });
  }

  /** Create a sidecar for a session */
  _createSidecar(sessionId, sessionEl) {
    if (this.sidecars.has(sessionId)) return;

    const sidecar = new RegentSidecar(
      sessionId,
      sessionEl,
      this.aiService,
      (id, events) => this._onEventsUpdate(id, events)
    );

    this.sidecars.set(sessionId, sidecar);

    // Register in sidebar
    this.sidebar.updateSession(sessionId, {
      name: sidecar.getDisplayName(),
      events: [],
      stats: sidecar.getStats(),
    });

    // Process existing messages
    const existingMessages = this.detector.getMessages(sessionEl);
    if (existingMessages.length > 0) {
      sidecar.ingestMessages(existingMessages);
    }

    console.log(`[Regent] Sidecar created for ${sessionId}`);
  }

  /** Destroy a sidecar */
  _destroySidecar(sessionId) {
    const sidecar = this.sidecars.get(sessionId);
    if (!sidecar) return;

    sidecar.destroy();
    this.sidecars.delete(sessionId);
    this.sidebar.removeSession(sessionId);

    console.log(`[Regent] Sidecar destroyed for ${sessionId}`);
  }

  /** Handle new messages for a session */
  _onNewMessages(sessionId, newMessageElements) {
    const sidecar = this.sidecars.get(sessionId);
    sidecar?.ingestMessages(newMessageElements);
  }

  /** Handle events update from a sidecar */
  _onEventsUpdate(sessionId, events) {
    const sidecar = this.sidecars.get(sessionId);
    if (!sidecar) return;

    this.sidebar.updateSession(sessionId, {
      name: sidecar.getDisplayName(),
      events,
      stats: sidecar.getStats(),
    });
  }

  /** Run calibration mode */
  async _runCalibration() {
    const selectors = await this.detector.startCalibration();
    if (!selectors) return;

    // Retry detection with new selectors
    const sessions = this.detector.detectSessions();
    for (const sessionEl of sessions) {
      const id = this.detector.getSessionId(sessionEl);
      this._createSidecar(id, sessionEl);
    }
  }

  /** Retry auto-calibration from sidebar button */
  async _runAutoCalibration() {
    try {
      const selectors = await this.detector.autoCalibrate(this.aiService);
      if (!selectors) return false;

      const sessions = this.detector.detectSessions();
      for (const sessionEl of sessions) {
        const id = this.detector.getSessionId(sessionEl);
        this._createSidecar(id, sessionEl);
      }
      return sessions.length > 0;
    } catch (err) {
      console.warn('[Regent] Auto-calibrate retry failed:', err.message);
      return false;
    }
  }

  /** Generate cross-session meta-summary */
  async _generateMetaSummary() {
    if (this.sidecars.size < 2) return; // Only useful with multiple sessions

    const sessionSummaries = [...this.sidecars.values()]
      .filter(s => s.events.length > 0)
      .map(s => ({
        name: s.getDisplayName(),
        events: s.events.slice(-5), // Last 5 events per session
      }));

    if (sessionSummaries.length < 2) return;

    const meta = await this.aiService.metaSummarize(sessionSummaries);
    this.sidebar.updateMeta(meta);
  }

  /** Handle messages from mothership */
  _onMothershipEvent(data) {
    switch (data.type) {
      case 'events:cross': {
        const { sessionId, events } = data.payload || {};
        if (sessionId && events?.length) this.sidebar.addCrossSessionEvents(sessionId, events);
        break;
      }
      case 'context:results':
        this.sidebar.showSearchResults(data.payload);
        break;
      case 'agent:started':
        this.sidebar.handleAgentStarted(data.payload);
        break;
      case 'agent:stream':
        this.sidebar.handleAgentStream(data.payload);
        break;
      case 'agent:tool_call':
        this.sidebar.handleAgentToolCall(data.payload);
        break;
      case 'agent:error':
        this.sidebar.handleAgentError(data.payload);
        break;
      case 'notification':
        this.sidebar.showNotification(data.payload);
        break;
    }
  }

  /** Destroy the entire regent system */
  destroy() {
    clearInterval(this._metaTimer);
    if (this._mothershipListener) chrome.runtime.onMessage.removeListener(this._mothershipListener);
    this.detector.destroy();
    this.sidecars.forEach(s => s.destroy());
    this.sidecars.clear();
    this.sidebar.destroy();
    this._initialized = false;
  }
}

// Lazy singleton — constructed only on first init() call
let orchestrator = null;

export function init() {
  orchestrator ??= new RegentOrchestratorClass();
  return orchestrator.init();
}

export function destroy() {
  return orchestrator?.destroy();
}

export default orchestrator;
