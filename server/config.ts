import { createRequire } from 'node:module';
import type { AiConfig } from './ai';
const require = createRequire(import.meta.url);
const example = require('../my_config.example.js');

export const defaultConfig = example.default_config || {};
export function mergedConfig(override: Record<string, unknown> = {}) { return { ...defaultConfig, ...override }; }
export function runtimeConfig(accountId: number, override: Record<string, unknown> = {}, ai?: AiConfig) {
  const accountConfig = mergedConfig(override);
  if (ai) {
    accountConfig.ai_judge_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.judgePrompt };
    accountConfig.ai_comments_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.commentPrompt };
    accountConfig.ai_relay_parm = { url: ai.baseUrl, body: { model: ai.model, temperature: ai.temperature, max_tokens: ai.maxTokens }, prompt: ai.relayPrompt };
  }
  return { default_config: defaultConfig, [`config_${accountId}`]: accountConfig };
}
