/**
 * MothershipManager — Popup UI for connecting the extension to the Mothership backend.
 * Handles URL/token input, connect/disconnect, and status display.
 */
export class MothershipManager {
  constructor() {
    this.urlInput = document.getElementById('mothershipUrl');
    this.tokenInput = document.getElementById('mothershipToken');
    this.connectBtn = document.getElementById('mothershipConnectBtn');
    this.disconnectBtn = document.getElementById('mothershipDisconnectBtn');
    this.statusDot = document.getElementById('mothershipStatusDot');
    this.statusText = document.getElementById('mothershipStatusText');

    this._bindEvents();
    this._loadState();
  }

  _bindEvents() {
    this.connectBtn.addEventListener('click', () => this._connect());
    this.disconnectBtn.addEventListener('click', () => this._disconnect());
  }

  async _loadState() {
    const data = await new Promise(r =>
      chrome.storage.sync.get(['mothershipUrl', 'mothershipToken', 'mothershipWorkspaceId'], r)
    );

    if (data.mothershipUrl) this.urlInput.value = data.mothershipUrl;
    if (data.mothershipToken) this.tokenInput.value = data.mothershipToken;

    // Check connection status
    chrome.runtime.sendMessage({ action: 'mothershipStatus' }, (res) => {
      this._updateUI(res?.connected);
    });
  }

  async _connect() {
    const url = this.urlInput.value.trim().replace(/\/+$/, '');
    const token = this.tokenInput.value.trim();
    if (!url || !token) return;

    this.connectBtn.textContent = 'Connecting...';
    this.connectBtn.disabled = true;

    // Verify token by calling health + auth check
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (!res.ok) throw new Error('Server unreachable');
    } catch {
      this._showError('Cannot reach server');
      this.connectBtn.textContent = 'Connect';
      this.connectBtn.disabled = false;
      return;
    }

    // Store credentials
    chrome.storage.sync.set({ mothershipUrl: url, mothershipToken: token });

    // Tell background to connect
    chrome.runtime.sendMessage({ action: 'mothershipConnect', url, token }, () => {
      // Give it a moment to connect
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'mothershipStatus' }, (res) => {
          this._updateUI(res?.connected);
          this.connectBtn.textContent = 'Connect';
          this.connectBtn.disabled = false;
        });
      }, 1000);
    });
  }

  _disconnect() {
    chrome.runtime.sendMessage({ action: 'mothershipDisconnect' });
    chrome.storage.sync.remove(['mothershipUrl', 'mothershipToken', 'mothershipWorkspaceId']);
    this.urlInput.value = '';
    this.tokenInput.value = '';
    this._updateUI(false);
  }

  _updateUI(connected) {
    this.statusDot.style.background = connected ? '#34c759' : '#aaa';
    this.statusDot.style.boxShadow = connected ? '0 0 6px rgba(52,199,89,0.4)' : 'none';
    this.statusText.textContent = connected ? 'Connected' : 'Disconnected';
    this.connectBtn.style.display = connected ? 'none' : '';
    this.disconnectBtn.style.display = connected ? '' : 'none';
  }

  _showError(msg) {
    this.statusText.textContent = msg;
    this.statusText.style.color = '#ff3b30';
    setTimeout(() => {
      this.statusText.style.color = '';
      this.statusText.textContent = 'Disconnected';
    }, 3000);
  }
}
