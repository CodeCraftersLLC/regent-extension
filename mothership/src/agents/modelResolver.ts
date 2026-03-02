/**
 * Model Resolver — maps our encrypted DB credentials to Mastra model configs.
 * Uses OpenAICompatibleConfig so any provider with an OpenAI-compatible
 * /chat/completions endpoint works out of the box.
 */

import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { ProviderCredential } from '../db/schema.js';

const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
  deepseek:    { url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openrouter:  { url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
  siliconflow: { url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  openai:      { url: 'https://api.openai.com/v1', model: 'gpt-4o' },
};

/**
 * Resolve provider credentials → Mastra OpenAICompatibleConfig.
 * Mastra routes this through its OpenAI-compatible provider automatically.
 */
export function resolveModel(creds: ProviderCredential): OpenAICompatibleConfig {
  const defaults = PROVIDER_DEFAULTS[creds.provider] ?? {};
  const baseUrl = (creds.api_url ?? defaults.url ?? '').replace(/\/+$/, '');
  const model = creds.model ?? defaults.model ?? 'deepseek-chat';

  return {
    id: `${creds.provider}/${model}` as `${string}/${string}`,
    url: baseUrl || undefined,
    apiKey: creds.api_key,
  };
}
