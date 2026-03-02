/**
 * RegentSidebar — Right sidebar UI for coding agent oversight
 *
 * Shadow DOM isolated. Shows key events per session.
 * Click-to-scroll with highlight animation. Collapsible. Theme-aware.
 */

import { isDarkMode } from '../utils/themeManager';
import regentCSS from './regent.css?raw';

const HIGHLIGHT_DURATION = 1500;

export class RegentSidebar {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.sidebar = null;
    this.sessionsContainer = null;
    this.metaEl = null;
    this._collapsed = false;
    this._sessionElements = new Map(); // sessionId → DOM section
    this._themeObserver = null;
    this._mediaQuery = null;
    this._themeUpdateFn = null;
  }

  /** Inject sidebar into the page */
  mount() {
    if (this.host) return;

    this.host = document.createElement('div');
    this.host.id = 'regent-sidebar-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = regentCSS;
    this.shadow.appendChild(style);

    // Build sidebar DOM
    this.sidebar = document.createElement('div');
    this.sidebar.id = 'regent-sidebar';
    if (isDarkMode()) this.sidebar.classList.add('dark-mode');

    this.sidebar.innerHTML = `
      <div class="regent-header">
        <div class="regent-header-content">
          <span class="regent-title">Regent</span>
          <span class="regent-connection-dot" title="Mothership: disconnected"></span>
          <span class="regent-badge">0 sessions</span>
        </div>
        <button class="regent-collapse-btn" title="Collapse sidebar">◀</button>
        <div class="regent-expand-indicator">▶</div>
      </div>
      <div class="regent-search" style="display:none">
        <input class="regent-search-input" type="text" placeholder="Search memory..." />
      </div>
      <div class="regent-search-results" style="display:none"></div>
      <div class="regent-agent-panel" style="display:none">
        <div class="regent-agent-header">
          <span class="regent-agent-title">Agents</span>
          <select class="regent-agent-select"><option value="">Select agent...</option></select>
          <button class="regent-agent-run-btn" title="Run agent">Run</button>
        </div>
        <input class="regent-agent-input" type="text" placeholder="Describe a task..." />
        <div class="regent-agent-output"></div>
      </div>
      <div class="regent-notifications" style="display:none"></div>
      <div class="regent-meta" style="display:none"></div>
      <div class="regent-sessions">
        <div class="regent-empty">
          <div class="regent-empty-icon">◎</div>
          <div class="regent-empty-text">Watching for coding agent sessions...</div>
        </div>
      </div>
    `;

    this.shadow.appendChild(this.sidebar);

    // Cache references
    this.sessionsContainer = this.sidebar.querySelector('.regent-sessions');
    this.metaEl = this.sidebar.querySelector('.regent-meta');
    this._searchEl = this.sidebar.querySelector('.regent-search');
    this._searchInput = this.sidebar.querySelector('.regent-search-input');
    this._searchResultsEl = this.sidebar.querySelector('.regent-search-results');
    this._searchDebounce = null;
    this._agentPanel = this.sidebar.querySelector('.regent-agent-panel');
    this._agentSelect = this.sidebar.querySelector('.regent-agent-select');
    this._agentInput = this.sidebar.querySelector('.regent-agent-input');
    this._agentOutput = this.sidebar.querySelector('.regent-agent-output');
    this._notificationsEl = this.sidebar.querySelector('.regent-notifications');
    this._currentRunId = null;

    // Agent run button — includes selected agentId
    this.sidebar.querySelector('.regent-agent-run-btn').addEventListener('click', () => {
      const agentId = this._agentSelect.value;
      const task = this._agentInput.value.trim();
      if (!agentId || !task) return;
      this._agentOutput.textContent = 'Starting agent...';
      chrome.runtime.sendMessage({
        action: 'mothershipSend',
        payload: { type: 'agent:start', payload: { agentId, input: task } },
      }).catch(() => {});
    });

    // Search input — debounced query via WS
    this._searchInput.addEventListener('input', () => {
      clearTimeout(this._searchDebounce);
      const q = this._searchInput.value.trim();
      if (!q) { this._hideSearchResults(); return; }
      this._searchDebounce = setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'mothershipSend',
          payload: { type: 'context:query', payload: { query: q, limit: 15 } },
        }).catch(() => {});
      }, 400);
    });

    // Collapse/expand
    const collapseBtn = this.sidebar.querySelector('.regent-collapse-btn');
    collapseBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.toggleCollapse();
    });

    this.sidebar.addEventListener('click', () => {
      if (this._collapsed) this.toggleCollapse();
    });

    // Theme detection
    this._watchTheme();

    document.body.appendChild(this.host);
  }

  /** Toggle sidebar collapse */
  toggleCollapse() {
    this._collapsed = !this._collapsed;
    this.sidebar.classList.toggle('collapsed', this._collapsed);
  }

  /** Add or update a session section */
  updateSession(sessionId, { name, events, stats }) {
    // Remove empty state
    const empty = this.sessionsContainer.querySelector('.regent-empty');
    if (empty) empty.remove();

    let section = this._sessionElements.get(sessionId);

    if (!section) {
      section = document.createElement('div');
      section.className = 'regent-session';
      section.dataset.sessionId = sessionId;
      section.innerHTML = `
        <div class="regent-session-header">
          <span class="session-name"></span>
          <span class="session-status active">Active</span>
        </div>
        <div class="session-stats"></div>
        <div class="regent-events"></div>
      `;
      this.sessionsContainer.appendChild(section);
      this._sessionElements.set(sessionId, section);
    }

    // Update header
    section.querySelector('.session-name').textContent = name || sessionId;

    // Update stats
    if (stats) {
      section.querySelector('.session-stats').textContent =
        `${stats.processedMessages} messages processed · ${stats.eventCount} events`;
    }

    // Update events
    const eventsContainer = section.querySelector('.regent-events');
    this._renderEvents(eventsContainer, events);

    // Update badge
    this._updateBadge();
  }

  /** Render event list for a session */
  _renderEvents(container, events) {
    // Detect new events (beyond what's already rendered)
    const existingCount = container.children.length;

    // Clear and rebuild (events array is append-only, so this is fine)
    container.innerHTML = '';

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const el = document.createElement('div');
      el.className = `regent-event${i >= existingCount ? ' entering' : ''}`;
      el.dataset.importance = evt.importance;
      el.dataset.eventId = evt.id;

      const time = new Date(evt.timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
      });

      el.innerHTML = `
        <div class="event-content">
          <div class="event-header">
            <span class="event-title">${this._escapeHtml(evt.title)}</span>
            <span class="event-time">${time}</span>
          </div>
          <div class="event-summary">${this._escapeHtml(evt.summary)}</div>
        </div>
      `;

      // Click-to-scroll
      el.addEventListener('click', () => this._scrollToEvent(evt));

      container.appendChild(el);
    }
  }

  /** Scroll to the source message and highlight it */
  _scrollToEvent(evt) {
    const el = evt.sourceElement;
    if (!el?.isConnected) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Add highlight pulse
    el.classList.add('regent-highlight-pulse');
    setTimeout(() => el.classList.remove('regent-highlight-pulse'), HIGHLIGHT_DURATION);

    // Inject the highlight CSS into the page (not shadow DOM) if not already
    if (!document.getElementById('regent-highlight-styles')) {
      const s = document.createElement('style');
      s.id = 'regent-highlight-styles';
      s.textContent = `
        .regent-highlight-pulse {
          position: relative;
          animation: regent-page-pulse 1.5s ease-out;
        }
        .regent-highlight-pulse::after {
          content: '';
          position: absolute;
          inset: -2px;
          border: 2px solid #007aff;
          border-radius: 8px;
          pointer-events: none;
          animation: regent-page-border 1.5s ease-out forwards;
        }
        @keyframes regent-page-pulse {
          0% { background-color: rgba(0, 122, 255, 0.08); }
          100% { background-color: transparent; }
        }
        @keyframes regent-page-border {
          0% { opacity: 0.8; }
          100% { opacity: 0; }
        }
      `;
      document.head.appendChild(s);
    }
  }

  /** Remove a session from the sidebar */
  removeSession(sessionId) {
    const section = this._sessionElements.get(sessionId);
    if (section) {
      section.remove();
      this._sessionElements.delete(sessionId);
    }

    // Show empty state if no sessions
    if (this._sessionElements.size === 0) {
      this.sessionsContainer.innerHTML = `
        <div class="regent-empty">
          <div class="regent-empty-icon">◎</div>
          <div class="regent-empty-text">No active sessions</div>
        </div>
      `;
    }

    this._updateBadge();
  }

  /** Show calibration UI */
  showCalibration(onCalibrate, onAutoCalibrate) {
    const empty = this.sessionsContainer.querySelector('.regent-empty');
    if (empty) empty.remove();

    const cal = document.createElement('div');
    cal.className = 'regent-calibration';
    cal.innerHTML = `
      <p style="color: var(--regent-text-secondary); font-size: 13px; margin: 0 0 16px;">
        Regent couldn't auto-detect sessions on this page.
      </p>
      ${onAutoCalibrate ? '<button class="regent-calibration-btn regent-auto-cal-btn">Auto-calibrate with AI</button>' : ''}
      <button class="regent-calibration-btn regent-manual-cal-btn">Click a chat message to calibrate</button>
    `;

    const autoBtn = cal.querySelector('.regent-auto-cal-btn');
    if (autoBtn) {
      autoBtn.addEventListener('click', async () => {
        autoBtn.textContent = 'Analyzing page...';
        autoBtn.disabled = true;
        const success = await onAutoCalibrate();
        if (success) { cal.remove(); return; }
        autoBtn.textContent = 'Auto-calibrate with AI';
        autoBtn.disabled = false;
      });
    }

    cal.querySelector('.regent-manual-cal-btn').addEventListener('click', async () => {
      cal.innerHTML = '<p style="color: var(--regent-text-secondary); font-size: 13px; padding: 8px;">Click any chat message on the page...</p>';
      await onCalibrate();
      cal.remove();
    });

    this.sessionsContainer.appendChild(cal);
  }

  /** Set mothership connection status indicator */
  setConnectionStatus(status) {
    const dot = this.sidebar?.querySelector('.regent-connection-dot');
    if (!dot) return;
    const connected = status === 'connected';
    dot.classList.toggle('connected', connected);
    dot.title = `Mothership: ${connected ? 'connected' : 'disconnected'}`;
    // Show/hide search bar and agent panel based on connection
    if (this._searchEl) this._searchEl.style.display = connected ? '' : 'none';
    if (this._agentPanel) this._agentPanel.style.display = connected ? '' : 'none';
    if (this._notificationsEl) this._notificationsEl.style.display = connected ? '' : 'none';
    if (!connected) {
      this._hideSearchResults();
      if (this._agentOutput) this._agentOutput.textContent = '';
    }
    // Fetch agents list when connected
    if (connected) this._loadAgents();
  }

  /** Fetch agents from mothership and populate the selector */
  _loadAgents() {
    chrome.storage.local.get(['mothershipUrl', 'mothershipToken', 'mothershipWorkspaceId'], async (data) => {
      if (!data.mothershipUrl || !data.mothershipToken || !data.mothershipWorkspaceId) return;
      try {
        const res = await fetch(`${data.mothershipUrl}/api/v1/workspaces/${data.mothershipWorkspaceId}/agents`, {
          headers: { Authorization: `Bearer ${data.mothershipToken}` },
        });
        if (!res.ok) return;
        const agents = await res.json();
        if (!this._agentSelect) return;
        this._agentSelect.innerHTML = '<option value="">Select agent...</option>';
        for (const a of agents) {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = a.name;
          this._agentSelect.appendChild(opt);
        }
      } catch {}
    });
  }

  /** Show a notification toast in the sidebar */
  showNotification(notification) {
    if (!this._notificationsEl) return;
    const toast = document.createElement('div');
    toast.className = 'regent-notification-toast';
    toast.innerHTML = `
      <div class="notification-title">${this._escapeHtml(notification.title)}</div>
      ${notification.body ? `<div class="notification-body">${this._escapeHtml(notification.body)}</div>` : ''}
    `;
    this._notificationsEl.appendChild(toast);
    // Auto-remove after 8 seconds
    setTimeout(() => toast.remove(), 8000);
  }

  /** Handle agent streaming chunks */
  handleAgentStream(data) {
    if (!this._agentOutput) return;
    if (data.done) {
      this._agentOutput.textContent += '\n--- Done ---';
      this._currentRunId = null;
      return;
    }
    if (data.chunk) {
      if (this._agentOutput.textContent === 'Starting agent...') this._agentOutput.textContent = '';
      this._agentOutput.textContent += data.chunk;
    }
  }

  /** Handle agent started confirmation */
  handleAgentStarted(data) {
    this._currentRunId = data.runId;
    if (this._agentOutput) this._agentOutput.textContent = '';
  }

  /** Handle agent tool call visualization */
  handleAgentToolCall(data) {
    if (!this._agentOutput) return;
    const el = document.createElement('div');
    el.className = 'regent-agent-tool-call';
    el.textContent = `Tool: ${data.tool}`;
    this._agentOutput.appendChild(el);
  }

  /** Handle agent error */
  handleAgentError(data) {
    if (!this._agentOutput) return;
    this._agentOutput.textContent += `\nError: ${data.error}`;
    this._currentRunId = null;
  }

  /** Display search results from mothership context:results */
  showSearchResults(results) {
    if (!results?.length) {
      this._searchResultsEl.innerHTML = '<div class="regent-search-empty">No results found</div>';
      this._searchResultsEl.style.display = '';
      return;
    }

    this._searchResultsEl.innerHTML = '';
    for (const r of results) {
      const el = document.createElement('div');
      el.className = 'regent-search-result';
      const time = r.created_at ? new Date(r.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      el.innerHTML = `
        <div class="search-result-content">${this._escapeHtml(r.content.slice(0, 120))}</div>
        <div class="search-result-meta">
          <span class="search-result-type">${r.source_type || 'event'}</span>
          <span class="search-result-time">${time}</span>
        </div>
      `;
      this._searchResultsEl.appendChild(el);
    }
    this._searchResultsEl.style.display = '';
  }

  /** Hide search results panel */
  _hideSearchResults() {
    if (this._searchResultsEl) {
      this._searchResultsEl.style.display = 'none';
      this._searchResultsEl.innerHTML = '';
    }
  }

  /** Display cross-session events received from mothership (other tabs/devices) */
  addCrossSessionEvents(sessionId, events) {
    if (!events?.length) return;

    // Get or create a "remote" session section
    let section = this._sessionElements.get(`remote:${sessionId}`);
    if (!section) {
      const empty = this.sessionsContainer?.querySelector('.regent-empty');
      if (empty) empty.remove();

      section = document.createElement('div');
      section.className = 'regent-session regent-session-remote';
      section.dataset.sessionId = `remote:${sessionId}`;
      section.innerHTML = `
        <div class="regent-session-header">
          <span class="session-name">Remote: ${this._escapeHtml(sessionId.slice(-8))}</span>
          <span class="session-status remote">Remote</span>
        </div>
        <div class="regent-events"></div>
      `;
      this.sessionsContainer?.appendChild(section);
      this._sessionElements.set(`remote:${sessionId}`, section);
    }

    const container = section.querySelector('.regent-events');
    for (const evt of events) {
      const el = document.createElement('div');
      el.className = 'regent-event entering';
      el.dataset.importance = evt.importance || 'medium';
      const time = new Date(evt.created_at || Date.now()).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
      });
      el.innerHTML = `
        <div class="event-content">
          <div class="event-header">
            <span class="event-title">${this._escapeHtml(evt.title)}</span>
            <span class="event-time">${time}</span>
          </div>
          <div class="event-summary">${this._escapeHtml(evt.summary)}</div>
        </div>
      `;
      container.appendChild(el);
    }

    this._updateBadge();
  }

  /** Update meta-summary */
  updateMeta(text) {
    if (!text) {
      this.metaEl.style.display = 'none';
      return;
    }
    this.metaEl.textContent = text;
    this.metaEl.style.display = 'block';
  }

  /** Update session count badge */
  _updateBadge() {
    const badge = this.sidebar.querySelector('.regent-badge');
    const count = this._sessionElements.size;
    badge.textContent = `${count} session${count !== 1 ? 's' : ''}`;
  }

  /** Watch for theme changes — stores references for cleanup */
  _watchTheme() {
    this._themeUpdateFn = () => {
      this.sidebar.classList.toggle('dark-mode', isDarkMode());
    };

    // System preference — store reference for removal
    this._mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    this._mediaQuery.addEventListener('change', this._themeUpdateFn);

    // DOM mutations on html/body (for site-level theme switches)
    this._themeObserver = new MutationObserver(this._themeUpdateFn);
    this._themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-mode'],
    });
  }

  /** Escape HTML */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Destroy sidebar — clean up all listeners */
  destroy() {
    this._themeObserver?.disconnect();
    if (this._mediaQuery && this._themeUpdateFn) {
      this._mediaQuery.removeEventListener('change', this._themeUpdateFn);
    }
    this._mediaQuery = null;
    this._themeUpdateFn = null;
    this.host?.remove();
    this.host = null;
    this._sessionElements.clear();
  }
}
