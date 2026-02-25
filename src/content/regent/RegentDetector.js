/**
 * RegentDetector — DOM auto-discovery for coding agent sessions
 *
 * Finds session containers and chat messages using:
 * 1. Stored selectors (from previous calibration)
 * 2. Heuristic analysis (scrollable containers with message-like children)
 * 3. Calibration mode (user clicks a message → selectors captured)
 */

const STORAGE_KEY = 'regentSelectors';
const DEBOUNCE_MS = 200;

// Default selector patterns to try (Happy Engineering + common patterns)
const SELECTOR_CANDIDATES = [
  // Happy Engineering likely patterns
  { session: '[data-session-id]', message: '[data-message-id]' },
  { session: '.session-container', message: '.message' },
  { session: '[class*="session"]', message: '[class*="message"]' },
  { session: '[class*="chat"]', message: '[class*="message"]' },
  // Generic patterns
  { session: '[role="log"]', message: '[role="article"]' },
  { session: '.conversation', message: '.turn' },
];

export class RegentDetector {
  constructor() {
    this.selectors = null;
    this.bodyObserver = null;
    this.sessionObservers = new Map();
    this.onSessionFound = null;
    this.onSessionLost = null;
    this.onNewMessages = null;
    this.knownSessions = new Set();
    this._debounceTimer = null;
  }

  /** Load stored selectors from chrome.storage */
  async loadSelectors() {
    return new Promise(resolve => {
      chrome.storage.sync.get(STORAGE_KEY, data => {
        this.selectors = data[STORAGE_KEY] || null;
        resolve(this.selectors);
      });
    });
  }

  /** Save discovered selectors */
  async saveSelectors(selectors) {
    this.selectors = selectors;
    return new Promise(resolve => {
      chrome.storage.sync.set({ [STORAGE_KEY]: selectors }, resolve);
    });
  }

  /** Try to detect sessions using stored or candidate selectors */
  detectSessions() {
    // Try stored selectors first
    if (this.selectors) {
      const sessions = document.querySelectorAll(this.selectors.session);
      if (sessions.length > 0) return [...sessions];
    }

    // Try candidate patterns
    for (const candidate of SELECTOR_CANDIDATES) {
      const sessions = document.querySelectorAll(candidate.session);
      if (sessions.length > 0) {
        // Validate: sessions should contain message-like children
        const hasMessages = [...sessions].some(
          s => s.querySelectorAll(candidate.message).length > 0
        );
        if (hasMessages) {
          this.selectors = candidate;
          this.saveSelectors(candidate);
          return [...sessions];
        }
      }
    }

    // Heuristic: find scrollable containers with many text-heavy children
    return this._heuristicDetect();
  }

  /** Heuristic session detection */
  _heuristicDetect() {
    const candidates = [];
    const scrollables = document.querySelectorAll('*');

    for (const el of scrollables) {
      const style = getComputedStyle(el);
      const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (!isScrollable) continue;

      const children = el.children;
      if (children.length < 3) continue;

      // Score: text density + child uniformity
      let textLength = 0;
      let uniformTags = 0;
      const firstTag = children[0]?.tagName;

      for (const child of children) {
        textLength += (child.textContent?.length || 0);
        if (child.tagName === firstTag) uniformTags++;
      }

      const score = (textLength / 100) + (uniformTags / children.length * 10) + children.length;

      if (score > 15) {
        candidates.push({ el, score, childTag: firstTag });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      const best = candidates[0];
      // Build selectors from the detected structure
      const sessionSelector = this._buildSelector(best.el);
      const messageSelector = best.childTag
        ? `${sessionSelector} > ${best.childTag.toLowerCase()}`
        : `${sessionSelector} > *`;

      this.selectors = { session: sessionSelector, message: messageSelector };
      return [best.el];
    }

    return [];
  }

  /** Build a CSS selector for an element */
  _buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      // Use meaningful classes (skip utility classes like 'p-4')
      const meaningful = [...current.classList].filter(
        c => c.length > 3 && !/^[a-z]-\d|^(p|m|w|h|flex|grid|text|bg)-/.test(c)
      );
      if (meaningful.length) {
        selector += `.${meaningful.map(c => CSS.escape(c)).join('.')}`;
      }

      // Add nth-child if needed for uniqueness
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(s => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  /** Extract session ID from element or URL */
  getSessionId(sessionEl) {
    // Check data attributes
    for (const attr of sessionEl.attributes) {
      if (/session|id/i.test(attr.name) && attr.value) return attr.value;
    }

    // Extract from URL
    const urlMatch = location.pathname.match(/\/session\/([^/]+)/);
    if (urlMatch) return urlMatch[1];

    // Fallback: use element index
    const allSessions = this.detectSessions();
    const idx = allSessions.indexOf(sessionEl);
    return `session-${idx >= 0 ? idx : Date.now()}`;
  }

  /** Get messages within a session */
  getMessages(sessionEl) {
    if (!this.selectors?.message) return [...sessionEl.children];
    // Use the message part of the selector (after the session selector)
    const msgSelector = this.selectors.message.includes(' ')
      ? this.selectors.message.split(' ').pop()
      : this.selectors.message;
    const messages = sessionEl.querySelectorAll(msgSelector);
    return messages.length > 0 ? [...messages] : [...sessionEl.children];
  }

  /** Start observing for new sessions and messages */
  startObserving({ onSessionFound, onSessionLost, onNewMessages }) {
    this.onSessionFound = onSessionFound;
    this.onSessionLost = onSessionLost;
    this.onNewMessages = onNewMessages;

    // Watch document body for new session containers
    this.bodyObserver = new MutationObserver(() => this._debouncedScan());
    this.bodyObserver.observe(document.body, { childList: true, subtree: true });

    // Also watch for SPA navigation
    this._watchNavigation();
  }

  /** Debounced DOM scan */
  _debouncedScan() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._scanForChanges(), DEBOUNCE_MS);
  }

  /** Scan for session changes */
  _scanForChanges() {
    const currentSessions = this.detectSessions();
    const currentIds = new Set();

    for (const sessionEl of currentSessions) {
      const id = this.getSessionId(sessionEl);
      currentIds.add(id);

      if (!this.knownSessions.has(id)) {
        this.knownSessions.add(id);
        this._watchSession(id, sessionEl);
        this.onSessionFound?.(id, sessionEl);
      }
    }

    // Check for removed sessions
    for (const id of this.knownSessions) {
      if (!currentIds.has(id)) {
        this.knownSessions.delete(id);
        this._unwatchSession(id);
        this.onSessionLost?.(id);
      }
    }
  }

  /** Watch a specific session for new messages */
  _watchSession(id, sessionEl) {
    let lastMessageCount = this.getMessages(sessionEl).length;

    const observer = new MutationObserver(() => {
      const messages = this.getMessages(sessionEl);
      if (messages.length > lastMessageCount) {
        const newMessages = messages.slice(lastMessageCount);
        lastMessageCount = messages.length;
        this.onNewMessages?.(id, newMessages, sessionEl);
      }
    });

    observer.observe(sessionEl, { childList: true, subtree: true });
    this.sessionObservers.set(id, observer);
  }

  /** Stop watching a session */
  _unwatchSession(id) {
    const observer = this.sessionObservers.get(id);
    observer?.disconnect();
    this.sessionObservers.delete(id);
  }

  /** Watch for SPA route changes */
  _watchNavigation() {
    let lastPath = location.pathname;

    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        // Reset and rescan on navigation
        this.knownSessions.clear();
        this.sessionObservers.forEach(o => o.disconnect());
        this.sessionObservers.clear();
        setTimeout(() => this._scanForChanges(), 500);
      }
    };

    // Intercept pushState/replaceState
    const orig = { pushState: history.pushState, replaceState: history.replaceState };
    history.pushState = function(...args) { orig.pushState.apply(this, args); check(); };
    history.replaceState = function(...args) { orig.replaceState.apply(this, args); check(); };
    window.addEventListener('popstate', check);
  }

  /** Enter calibration mode — user clicks a message to teach the detector */
  startCalibration() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483646',
        background: 'rgba(0,0,0,0.3)', cursor: 'crosshair',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      });

      const prompt = document.createElement('div');
      Object.assign(prompt.style, {
        background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '20px 32px',
        borderRadius: '12px', fontSize: '16px', fontFamily: '-apple-system, sans-serif',
        textAlign: 'center', maxWidth: '400px', lineHeight: '1.6',
        backdropFilter: 'blur(8px)',
      });
      prompt.textContent = 'Click on any chat message to help Regent learn the page structure.';
      overlay.appendChild(prompt);

      let hoverEl = null;

      const onMove = e => {
        if (hoverEl) hoverEl.style.outline = '';
        hoverEl = document.elementFromPoint(e.clientX, e.clientY);
        if (hoverEl && hoverEl !== overlay && !overlay.contains(hoverEl)) {
          hoverEl.style.outline = '2px solid #007aff';
        }
      };

      const onClick = e => {
        e.preventDefault();
        e.stopPropagation();

        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (!target || target === overlay || overlay.contains(target)) return;

        // Clean up
        if (hoverEl) hoverEl.style.outline = '';
        overlay.remove();
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);

        // Build selectors from clicked element
        const messageSelector = this._buildSelector(target);

        // Walk up to find the scrollable session container
        let session = target.parentElement;
        while (session && session !== document.body) {
          const style = getComputedStyle(session);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
          session = session.parentElement;
        }

        const sessionSelector = session ? this._buildSelector(session) : '';
        const selectors = { session: sessionSelector, message: messageSelector };

        this.saveSelectors(selectors);
        resolve(selectors);
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.body.appendChild(overlay);
    });
  }

  /** Stop all observation */
  destroy() {
    this.bodyObserver?.disconnect();
    this.sessionObservers.forEach(o => o.disconnect());
    this.sessionObservers.clear();
    this.knownSessions.clear();
    clearTimeout(this._debounceTimer);
  }
}
