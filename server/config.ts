import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const example = require('../my_config.example.js');

export const defaultConfig = example.default_config || {};
export function mergedConfig(override: Record<string, unknown> = {}) { return { ...defaultConfig, ...override }; }
export function runtimeConfig(accountId: number, override: Record<string, unknown> = {}) {
  return { default_config: defaultConfig, [`config_${accountId}`]: mergedConfig(override) };
}
