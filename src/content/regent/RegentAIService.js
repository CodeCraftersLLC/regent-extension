/**
 * RegentAIService — Lightweight AI summarization for regent sidecars
 *
 * Uses the same provider/model/API key configured in extension settings.
 * Non-streaming calls via the background proxy for key event extraction.
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

export class RegentAIService {
  constructor() {
    this._settings = null;
    this._settingsAge = 0;
  }

  /** Fetch extension settings (cached for 60s) */
  async _getSettings() {
    if (this._settings && Date.now() - this._settingsAge < 60_000) return this._settings;

    this._settings = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: 'getSettings' }, resolve)
    );
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

    return { apiKey, apiUrl, model: settings.model || 'deepseek-chat' };
  }

  /** Send a non-streaming summarization request */
  async summarize(messageTexts) {
    if (!messageTexts?.length) return [];

    const settings = await this._getSettings();
    const { apiKey, apiUrl, model } = this._resolveProvider(settings);

    if (!apiKey) {
      console.warn('[Regent] No API key configured — skipping summarization');
      return [];
    }

    // Format messages for the prompt
    const formattedMessages = messageTexts
      .map((text, i) => `[Message ${i}]\n${text.slice(0, 2000)}`)
      .join('\n\n---\n\n');

    try {
      const response = await new Promise((resolve, reject) => {
        // Listen for non-streaming response
        const handler = msg => {
          if (msg.type !== 'streamResponse') return;
          chrome.runtime.onMessage.removeListener(handler);

          if (!msg.response.ok) {
            reject(new Error(msg.response.error || 'Summarization failed'));
            return;
          }

          // For non-streaming, the full response comes in one chunk
          if (msg.response.data) {
            const dataLine = msg.response.data.replace(/^data: /, '').replace(/\n\n$/, '');
            if (dataLine === '[DONE]') {
              resolve(null);
              return;
            }
            try {
              const parsed = JSON.parse(dataLine);
              const content = parsed.choices?.[0]?.message?.content
                || parsed.choices?.[0]?.delta?.content || '';
              resolve(content);
            } catch {
              resolve(dataLine);
            }
          }
        };

        chrome.runtime.onMessage.addListener(handler);

        // Set a timeout
        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error('Summarization timeout'));
        }, 30_000);

        chrome.runtime.sendMessage({
          action: 'proxyRequest',
          url: apiUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: formattedMessages },
            ],
            stream: false,
            temperature: 0.3,
            max_tokens: 2048,
          }),
        });
      });

      if (!response) return [];

      // Parse JSON from response (handle possible markdown fencing)
      const cleaned = response.replace(/```json\n?|\n?```/g, '').trim();
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
    const { apiKey, apiUrl, model } = this._resolveProvider(settings);
    if (!apiKey) return '';

    const content = sessionSummaries
      .map(s => `## ${s.name}\n${s.events.map(e => `- [${e.importance}] ${e.title}: ${e.summary}`).join('\n')}`)
      .join('\n\n');

    try {
      const response = await new Promise((resolve, reject) => {
        const handler = msg => {
          if (msg.type !== 'streamResponse') return;
          chrome.runtime.onMessage.removeListener(handler);
          if (!msg.response.ok) { reject(new Error('Meta-summary failed')); return; }
          if (msg.response.data) {
            const dataLine = msg.response.data.replace(/^data: /, '').replace(/\n\n$/, '');
            if (dataLine === '[DONE]') { resolve(''); return; }
            try {
              const parsed = JSON.parse(dataLine);
              resolve(parsed.choices?.[0]?.message?.content || '');
            } catch { resolve(''); }
          }
        };
        chrome.runtime.onMessage.addListener(handler);
        setTimeout(() => { chrome.runtime.onMessage.removeListener(handler); resolve(''); }, 30_000);

        chrome.runtime.sendMessage({
          action: 'proxyRequest', url: apiUrl, method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Provide a brief 2-3 sentence overview of what is happening across all these coding sessions. Focus on overall progress and any blocked/critical items.' },
              { role: 'user', content },
            ],
            stream: false, temperature: 0.3, max_tokens: 512,
          }),
        });
      });
      return response;
    } catch {
      return '';
    }
  }
}
