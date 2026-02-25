/**
 * RegentAIService — Lightweight AI summarization for regent sidecars
 *
 * Uses the same provider/model/API key configured in extension settings.
 * Non-streaming calls via the background proxy's sendResponse callback.
 */

const SYSTEM_PROMPT = `You are a coding session analyst. Given chat messages from a Claude Code coding session, extract KEY EVENTS — moments that matter for a high-level overview.

Return ONLY a JSON array (no markdown, no code fences):
[{
  "title": "short 5-8 word title",
  "summary": "1-2 sentence explanation",
  "importance": "high" | "medium" | "low",
  "messageIndex": <0-based index of most relevant message in the batch>
}]

Focus on: decisions made, errors encountered, files changed, features implemented, bugs fixed, architectural choices, permission requests, tool usage results.
Skip: routine acknowledgments, thinking/reasoning traces, repetitive back-and-forth.
Return empty array [] if no significant events found.`;

let _requestCounter = 0;

export class RegentAIService {
  constructor() {
    this._settings = null;
    this._settingsAge = 0;
  }

  /** Fetch extension settings (cached for 60s) with error validation */
  async _getSettings() {
    if (this._settings && Date.now() - this._settingsAge < 60_000) return this._settings;

    this._settings = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getSettings' }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

    if (!this._settings) throw new Error('Failed to retrieve extension settings');
    this._settingsAge = Date.now();
    return this._settings;
  }

  /** Resolve API URL and key from settings */
  _resolveProvider(settings) {
    const provider = settings.provider || 'deepseek';
    const providerKeyMap = {
      deepseek: 'deepseekApiKey', siliconflow: 'siliconflowApiKey',
      openrouter: 'openrouterApiKey', volcengine: 'volcengineApiKey',
      tencentcloud: 'tencentcloudApiKey', iflytekstar: 'iflytekstarApiKey',
      baiducloud: 'baiducloudApiKey', aliyun: 'aliyunApiKey',
      aihubmix: 'aihubmixApiKey',
    };
    const providerUrlMap = {
      deepseek: 'https://api.deepseek.com/v1/chat/completions',
      siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      volcengine: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      tencentcloud: 'https://api.lkeap.cloud.tencent.com/v1/chat/completions',
      iflytekstar: 'https://maas-api.cn-huabei-1.xf-yun.com/v1/chat/completions',
      baiducloud: 'https://qianfan.baidubce.com/v2/chat/completions',
      aliyun: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      aihubmix: 'https://aihubmix.com/v1/chat/completions',
    };

    let apiKey, apiUrl;

    if (provider.startsWith('custom_')) {
      apiKey = settings.customApiKey;
      if (!apiKey && settings.customProviders) {
        const cp = settings.customProviders.find(p => p.id === provider);
        apiKey = cp?.apiKey || '';
      }
      apiUrl = settings.customApiUrl;
    } else {
      apiKey = settings[providerKeyMap[provider]] || '';
      const customUrlKey = `${provider}CustomApiUrl`;
      apiUrl = settings[customUrlKey] || providerUrlMap[provider] || providerUrlMap.deepseek;
    }

    // Validate model — use provider default only for deepseek
    const model = settings.model || (provider === 'deepseek' ? 'deepseek-chat' : '');

    return { apiKey, apiUrl, model, provider };
  }

  /** Send a non-streaming request via background proxy's sendResponse callback */
  _proxyRequest(url, apiKey, model, messages, maxTokens = 2048) {
    const requestId = `regent-${++_requestCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Regent request timeout (30s)'));
      }, 30_000);

      chrome.runtime.sendMessage({
        action: 'proxyRequest',
        requestId,
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          temperature: 0.3,
          max_tokens: maxTokens,
        }),
      }, response => {
        clearTimeout(timeout);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        // Non-streaming: background returns { status, ok, data, text } via sendResponse
        if (!response?.ok) {
          const errMsg = response?.data?.error?.message || response?.text || response?.error || 'Request failed';
          reject(new Error(`API error (${response?.status}): ${errMsg}`));
          return;
        }

        // Extract content from response
        const content = response.data?.choices?.[0]?.message?.content || '';
        resolve(content);
      });
    });
  }

  /** Send a non-streaming summarization request */
  async summarize(messageTexts) {
    if (!messageTexts?.length) return [];

    const settings = await this._getSettings();
    const { apiKey, apiUrl, model, provider } = this._resolveProvider(settings);

    if (!apiKey) {
      console.warn('[Regent] No API key configured — skipping summarization');
      return [];
    }

    if (!model) {
      console.warn(`[Regent] No model configured for provider "${provider}" — skipping summarization`);
      return [];
    }

    // Format messages for the prompt
    const formattedMessages = messageTexts
      .map((text, i) => `[Message ${i}]\n${text.slice(0, 2000)}`)
      .join('\n\n---\n\n');

    try {
      const content = await this._proxyRequest(apiUrl, apiKey, model, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: formattedMessages },
      ]);

      if (!content) return [];

      // Parse JSON from response (handle possible markdown fencing)
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
      const events = JSON.parse(cleaned);
      return Array.isArray(events) ? events : [];
    } catch (err) {
      console.warn('[Regent] Summarization error:', err.message);
      return [];
    }
  }

  /** Generate a meta-summary across multiple sessions */
  async metaSummarize(sessionSummaries) {
    if (!sessionSummaries?.length) return '';

    const settings = await this._getSettings();
    const { apiKey, apiUrl, model, provider } = this._resolveProvider(settings);

    if (!apiKey || !model) {
      console.warn(`[Regent] Cannot meta-summarize: missing ${!apiKey ? 'API key' : 'model'} for "${provider}"`);
      return '';
    }

    const userContent = sessionSummaries
      .map(s => `## ${s.name}\n${s.events.map(e => `- [${e.importance}] ${e.title}: ${e.summary}`).join('\n')}`)
      .join('\n\n');

    try {
      return await this._proxyRequest(apiUrl, apiKey, model, [
        { role: 'system', content: 'Provide a brief 2-3 sentence overview of what is happening across all these coding sessions. Focus on overall progress and any blocked/critical items.' },
        { role: 'user', content: userContent },
      ], 512);
    } catch (err) {
      console.warn('[Regent] Meta-summary error:', err.message);
      return '';
    }
  }
}
