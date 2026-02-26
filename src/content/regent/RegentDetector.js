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
  { session: '[data-session-id]', message: '[data-message-id]' },
  { session: '.session-container', message: '.message' },
  { session: '[class*="session"]', message: '[class*="message"]' },
  { session: '[class*="chat"]', message: '[class*="message"]' },
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
    this._origPushState = null;
    this._origReplaceState = null;
    this._popstateHandler = null;
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

  /** Safely run querySelectorAll — returns empty array on invalid selector */
  _safeQueryAll(root, selector) {
    if (!selector) return [];
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }

  /** Try to detect sessions using stored or candidate selectors */
  detectSessions() {
    // Try stored selectors first
    if (this.selectors?.session) {
      const sessions = this._safeQueryAll(document, this.selectors.session);
      if (sessions.length > 0) return sessions;
    }

    // Try candidate patterns
    for (const candidate of SELECTOR_CANDIDATES) {
      const sessions = this._safeQueryAll(document, candidate.session);
      if (sessions.length > 0) {
        const hasMessages = sessions.some(
          s => this._safeQueryAll(s, candidate.message).length > 0
        );
        if (hasMessages) {
          this.selectors = candidate;
          this.saveSelectors(candidate);
          return sessions;
        }
      }
    }

    // Heuristic: find scrollable containers with many text-heavy children
    return this._heuristicDetect();
  }

  /** Heuristic session detection — optimized scan with full-DOM fallback */
  _heuristicDetect() {
    // Fast pass: target elements likely to be scrollable via class/role/inline style
    const fastSelector =
      '[style*="overflow"], [class*="scroll"], [class*="chat"], [class*="session"], ' +
      '[class*="message"], [class*="conversation"], [role="log"], [role="feed"], main, article';

    let result = this._scoreScrollables(document.querySelectorAll(fastSelector));

    // Fallback: if fast pass found nothing, scan all elements with ≥3 children
    // (avoids getComputedStyle on leaf nodes which are the vast majority)
    if (!result) {
      const allWithChildren = document.querySelectorAll('*');
      result = this._scoreScrollables(allWithChildren);
    }

    if (result) {
      const sessionSelector = this._buildSelector(result.el);
      const messageSelector = result.childTag
        ? `${sessionSelector} > ${result.childTag.toLowerCase()}`
        : `${sessionSelector} > *`;
      this.selectors = { session: sessionSelector, message: messageSelector };
      return [result.el];
    }

    return [];
  }

  /** Score a NodeList for scrollable containers with message-like children */
  _scoreScrollables(elements) {
    const candidates = [];

    for (const el of elements) {
      const children = el.children;
      if (children.length < 3) continue;

      const style = getComputedStyle(el);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;

      let textLength = 0;
      let uniformTags = 0;
      const firstTag = children[0]?.tagName;

      for (const child of children) {
        textLength += (child.textContent?.length || 0);
        if (child.tagName === firstTag) uniformTags++;
      }

      const score = (textLength / 100) + (uniformTags / children.length * 10) + children.length;
      if (score > 15) candidates.push({ el, score, childTag: firstTag });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
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

      const meaningful = [...current.classList].filter(
        c => c.length > 3 && !/^[a-z]-\d|^(p|m|w|h|flex|grid|text|bg)-/.test(c)
      );
      if (meaningful.length) {
        selector += `.${meaningful.map(c => CSS.escape(c)).join('.')}`;
      }

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
    for (const attr of sessionEl.attributes) {
      if (/session|id/i.test(attr.name) && attr.value) return attr.value;
    }

    const urlMatch = location.pathname.match(/\/session\/([^/]+)/);
    if (urlMatch) return urlMatch[1];

    const allSessions = this.detectSessions();
    const idx = allSessions.indexOf(sessionEl);
    return `session-${idx >= 0 ? idx : Date.now()}`;
  }

  /** Get messages within a session — use full selector scoped to sessionEl */
  getMessages(sessionEl) {
    if (!this.selectors?.message) return [...sessionEl.children];

    // Try the full message selector scoped within the session element
    const messages = this._safeQueryAll(sessionEl, this.selectors.message);
    if (messages.length > 0) return messages;

    // Fallback: extract the last segment of a compound selector and query within sessionEl
    // Handles both "parent > child" and "ancestor descendant" patterns
    const selector = this.selectors.message;
    const lastSegment = selector.includes('>')
      ? selector.split('>').pop().trim()
      : selector.includes(' ')
        ? selector.split(/\s+/).pop()
        : null;

    if (lastSegment) {
      const scoped = this._safeQueryAll(sessionEl, lastSegment);
      if (scoped.length > 0) return scoped;
    }

    return [...sessionEl.children];
  }

  /** Start observing for new sessions and messages */
  startObserving({ onSessionFound, onSessionLost, onNewMessages }) {
    this.onSessionFound = onSessionFound;
    this.onSessionLost = onSessionLost;
    this.onNewMessages = onNewMessages;

    this.bodyObserver = new MutationObserver(() => this._debouncedScan());
    this.bodyObserver.observe(document.body, { childList: true, subtree: true });

    this._watchNavigation();
  }

  _debouncedScan() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._scanForChanges(), DEBOUNCE_MS);
  }

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

    for (const id of this.knownSessions) {
      if (!currentIds.has(id)) {
        this.knownSessions.delete(id);
        this._unwatchSession(id);
        this.onSessionLost?.(id);
      }
    }
  }

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

  _unwatchSession(id) {
    const observer = this.sessionObservers.get(id);
    observer?.disconnect();
    this.sessionObservers.delete(id);
  }

  /** Watch for SPA route changes — stores originals for cleanup */
  _watchNavigation() {
    let lastPath = location.pathname;

    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        this.knownSessions.clear();
        this.sessionObservers.forEach(o => o.disconnect());
        this.sessionObservers.clear();
        setTimeout(() => this._scanForChanges(), 500);
      }
    };

    // Store originals so destroy() can restore them
    this._origPushState = history.pushState;
    this._origReplaceState = history.replaceState;

    const origPush = this._origPushState;
    const origReplace = this._origReplaceState;
    history.pushState = function(...args) { origPush.apply(this, args); check(); };
    history.replaceState = function(...args) { origReplace.apply(this, args); check(); };

    this._popstateHandler = check;
    window.addEventListener('popstate', this._popstateHandler);
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

        if (hoverEl) hoverEl.style.outline = '';
        overlay.remove();
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);

        const messageSelector = this._buildSelector(target);

        // Walk up to find the scrollable session container
        let session = target.parentElement;
        while (session && session !== document.body) {
          const style = getComputedStyle(session);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') break;
          session = session.parentElement;
        }

        // Guard: ensure valid session selector
        const sessionSelector = (session && session !== document.body)
          ? this._buildSelector(session)
          : null;

        if (!sessionSelector) {
          console.warn('[Regent] Calibration: could not find scrollable session container');
          resolve(null);
          return;
        }

        const selectors = { session: sessionSelector, message: messageSelector };
        this.saveSelectors(selectors);
        resolve(selectors);
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.body.appendChild(overlay);
    });
  }

  /** Stop all observation and restore monkey-patches */
  destroy() {
    this.bodyObserver?.disconnect();
    this.sessionObservers.forEach(o => o.disconnect());
    this.sessionObservers.clear();
    this.knownSessions.clear();
    clearTimeout(this._debounceTimer);

    // Restore history API
    if (this._origPushState) history.pushState = this._origPushState;
    if (this._origReplaceState) history.replaceState = this._origReplaceState;
    if (this._popstateHandler) window.removeEventListener('popstate', this._popstateHandler);

    this._origPushState = null;
    this._origReplaceState = null;
    this._popstateHandler = null;
  }
}
