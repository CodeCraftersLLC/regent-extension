/**
 * RegentSidecar — Per-session watcher
 *
 * Monitors one coding agent session's chat messages.
 * Batches new messages and calls AI for key event extraction.
 * Links each event to its source DOM element for click-to-scroll.
 */

const BUFFER_THRESHOLD = 5;     // Summarize after N new messages
const TIME_THRESHOLD = 30_000;  // Or after 30s with pending messages
let nextEventId = 0;

export class RegentSidecar {
  /**
   * @param {string} sessionId
   * @param {HTMLElement} sessionEl - The session container DOM element
   * @param {import('./RegentAIService').RegentAIService} aiService
   * @param {Function} onEventsUpdate - Callback when new events are added
   */
  constructor(sessionId, sessionEl, aiService, onEventsUpdate) {
    this.sessionId = sessionId;
    this.sessionEl = sessionEl;
    this.aiService = aiService;
    this.onEventsUpdate = onEventsUpdate;

    this.events = [];
    this._buffer = [];       // { text, element, timestamp }
    this._bufferElements = [];
    this._timer = null;
    this._summarizing = false;
    this._destroyed = false;
    this._processedCount = 0;
  }

  /** Receive new messages from the detector */
  ingestMessages(newMessageElements) {
    if (this._destroyed) return;

    for (const el of newMessageElements) {
      const text = el.textContent?.trim();
      if (!text || text.length < 10) continue; // Skip trivial messages

      this._buffer.push({
        text,
        element: el,
        timestamp: Date.now(),
      });
    }

    // Check if we should trigger summarization
    if (this._buffer.length >= BUFFER_THRESHOLD) {
      this._triggerSummarize();
    } else if (this._buffer.length > 0 && !this._timer) {
      this._timer = setTimeout(() => this._triggerSummarize(), TIME_THRESHOLD);
    }
  }

  /** Trigger AI summarization of buffered messages */
  async _triggerSummarize() {
    if (this._summarizing || this._destroyed || !this._buffer.length) return;

    clearTimeout(this._timer);
    this._timer = null;
    this._summarizing = true;

    // Snapshot and clear buffer
    const batch = [...this._buffer];
    this._buffer = [];

    try {
      const messageTexts = batch.map(m => m.text);
      const aiEvents = await this.aiService.summarize(messageTexts);

      for (const evt of aiEvents) {
        // Link to source DOM element
        const msgIdx = Math.min(
          Math.max(0, evt.messageIndex || 0),
          batch.length - 1
        );
        const sourceMsg = batch[msgIdx];

        this.events.push({
          id: `evt-${++nextEventId}`,
          title: evt.title,
          summary: evt.summary,
          importance: evt.importance || 'medium',
          timestamp: sourceMsg.timestamp,
          sourceElement: sourceMsg.element,
          sessionId: this.sessionId,
        });
      }

      this._processedCount += batch.length;
      this.onEventsUpdate?.(this.sessionId, this.events);
    } catch (err) {
      console.warn(`[Regent:Sidecar:${this.sessionId}] Summarization failed:`, err.message);
      // Drop failed batch to avoid infinite retry loop — messages are lost but system stays stable
      this._processedCount += batch.length;
    } finally {
      this._summarizing = false;

      // If more messages arrived during summarization, process them
      if (this._buffer.length >= BUFFER_THRESHOLD) {
        this._triggerSummarize();
      } else if (this._buffer.length > 0) {
        this._timer = setTimeout(() => this._triggerSummarize(), TIME_THRESHOLD);
      }
    }
  }

  /** Get session display name */
  getDisplayName() {
    // Try to extract from URL or element content
    const urlMatch = location.pathname.match(/\/session\/([^/]+)/);
    if (urlMatch) return urlMatch[1].slice(0, 12);

    // Try element attributes
    const name = this.sessionEl.getAttribute('data-session-name')
      || this.sessionEl.getAttribute('aria-label')
      || `Session ${this.sessionId.slice(-6)}`;
    return name.length > 30 ? name.slice(0, 27) + '...' : name;
  }

  /** Get stats for this sidecar */
  getStats() {
    return {
      sessionId: this.sessionId,
      name: this.getDisplayName(),
      eventCount: this.events.length,
      pendingMessages: this._buffer.length,
      processedMessages: this._processedCount,
      isSummarizing: this._summarizing,
    };
  }

  /** Destroy this sidecar */
  destroy() {
    this._destroyed = true;
    clearTimeout(this._timer);
    this._buffer = [];
  }
}
