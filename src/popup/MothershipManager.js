/**
 * MothershipManager — Popup UI for connecting the extension to the Mothership backend.
 * Handles URL/token input, workspace selection, connect/disconnect, and status display.
 */
export class MothershipManager {
  constructor() {
    this.urlInput = document.getElementById('mothershipUrl');
    this.tokenInput = document.getElementById('mothershipToken');
    this.workspaceSelect = document.getElementById('mothershipWorkspaceSelect');
    this.connectBtn = document.getElementById('mothershipConnectBtn');
    this.disconnectBtn = document.getElementById('mothershipDisconnectBtn');
    this.statusDot = document.getElementById('mothershipStatusDot');
    this.statusText = document.getElementById('mothershipStatusText');
    this._workspaces = [];

    this._bindEvents();
    this._loadState();
  }

  _bindEvents() {
    this.connectBtn.addEventListener('click', () => this._connect());
    this.disconnectBtn.addEventListener('click', () => this._disconnect());
    // Auto-fetch workspaces when token field loses focus
    this.tokenInput.addEventListener('blur', () => this._fetchWorkspaces());
    this.workspaceSelect.addEventListener('change', () => {
      const wsId = this.workspaceSelect.value;
      if (wsId) chrome.storage.local.set({ mothershipWorkspaceId: wsId });
    });
  }

  async _loadState() {
    const data = await new Promise(r =>
      chrome.storage.local.get(['mothershipUrl', 'mothershipToken', 'mothershipWorkspaceId'], r)
    );

    if (data.mothershipUrl) this.urlInput.value = data.mothershipUrl;
    if (data.mothershipToken) this.tokenInput.value = data.mothershipToken;

    // Check connection status
    chrome.runtime.sendMessage({ action: 'mothershipStatus' }, (res) => {
      this._updateUI(res?.connected, data.mothershipWorkspaceId);
    });

    // If we have URL + token, fetch workspaces to populate selector
    if (data.mothershipUrl && data.mothershipToken) {
      this._fetchWorkspaces(data.mothershipWorkspaceId);
    }
  }

  async _fetchWorkspaces(selectedId) {
    const url = this.urlInput.value.trim().replace(/\/+$/, '');
    const token = this.tokenInput.value.trim();
    if (!url || !token) return;

    try {
      const res = await fetch(`${url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      this._workspaces = await res.json();

      // Populate selector
      this.workspaceSelect.innerHTML = '<option value="">Select workspace...</option>';
      for (const ws of this._workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = ws.name;
        if (ws.id === selectedId) opt.selected = true;
        this.workspaceSelect.appendChild(opt);
      }
      this.workspaceSelect.style.display = this._workspaces.length > 1 ? '' : 'none';

      // Auto-select if only one
      if (this._workspaces.length === 1 && !selectedId) {
        this.workspaceSelect.value = this._workspaces[0].id;
      }
    } catch {}
  }

  async _connect() {
    const url = this.urlInput.value.trim().replace(/\/+$/, '');
    const token = this.tokenInput.value.trim();
    if (!url || !token) return;

    this.connectBtn.textContent = 'Connecting...';
    this.connectBtn.disabled = true;

    try {
      const healthRes = await fetch(`${url}/api/v1/health`);
      if (!healthRes.ok) throw new Error('Server unreachable');

      // Fetch workspaces
      const wsRes = await fetch(`${url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!wsRes.ok) {
        this._showError('Invalid token');
        this.connectBtn.textContent = 'Connect';
        this.connectBtn.disabled = false;
        return;
      }
      this._workspaces = await wsRes.json();
      if (!this._workspaces.length) {
        this._showError('No workspace found');
        this.connectBtn.textContent = 'Connect';
        this.connectBtn.disabled = false;
        return;
      }

      // Use selected workspace or default to first
      const workspaceId = this.workspaceSelect.value || this._workspaces[0].id;

      // Populate selector
      this.workspaceSelect.innerHTML = '';
      for (const ws of this._workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = ws.name;
        if (ws.id === workspaceId) opt.selected = true;
        this.workspaceSelect.appendChild(opt);
      }
      this.workspaceSelect.style.display = this._workspaces.length > 1 ? '' : 'none';

      chrome.storage.local.set({ mothershipUrl: url, mothershipToken: token, mothershipWorkspaceId: workspaceId });
    } catch {
      this._showError('Cannot reach server');
      this.connectBtn.textContent = 'Connect';
      this.connectBtn.disabled = false;
      return;
    }

    // Tell background to connect
    chrome.runtime.sendMessage({ action: 'mothershipConnect', url, token }, () => {
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
    chrome.storage.local.remove(['mothershipUrl', 'mothershipToken', 'mothershipWorkspaceId']);
    this.urlInput.value = '';
    this.tokenInput.value = '';
    this.workspaceSelect.innerHTML = '<option value="">Select workspace...</option>';
    this.workspaceSelect.style.display = 'none';
    this._updateUI(false);
  }

  _updateUI(connected, _selectedWsId) {
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
