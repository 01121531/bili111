import { AppDatabase } from './db';
import { decrypt, encrypt } from './security';

export type AiConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  enableJudge: boolean;
  enableComments: boolean;
  enableRelay: boolean;
  judgePrompt: string;
  commentPrompt: string;
  relayPrompt: string;
  fallbackComment: string;
  fallbackRelay: string;
  allowEmptyRelay: boolean;
  maxRequestsPerRun: number;
  sensitiveWords: string[];
};

const providers = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/chat/completions', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['qwen-plus', 'qwen-turbo'] },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1/chat/completions', models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'] },
  { id: 'custom', name: '自定义 OpenAI 兼容接口', baseUrl: '', models: [] }
];

const defaultConfig: AiConfig = {
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat',
  temperature: 0.7, maxTokens: 300, timeoutMs: 120000, retries: 1,
  enableJudge: false, enableComments: false, enableRelay: false,
  judgePrompt: '你是一个B站抽奖判断助手。请根据动态内容判断是否为抽奖动态，并只输出 JSON：{"has_key_words":boolean,"needAt":boolean,"needTopic":string,"drawtime":number,"more":string}。',
  commentPrompt: '你是一个B站用户，请根据动态内容生成一条自然、简短、无表情且不包含敏感词的评论。只输出评论正文。',
  relayPrompt: '你是一个B站用户，请根据动态内容生成一句自然、简短的转发附言。只输出附言正文。',
  fallbackComment: '参与一下，祝好运！', fallbackRelay: '来参加一下，祝大家好运！', allowEmptyRelay: false,
  maxRequestsPerRun: 30, sensitiveWords: []
};

const accountOverrideKeys = ['enableJudge', 'enableComments', 'enableRelay', 'commentPrompt', 'relayPrompt'] as const;
type AccountOverrideKey = typeof accountOverrideKeys[number];

function number(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function bool(value: unknown, fallback: boolean) { return typeof value === 'boolean' ? value : fallback; }
function string(value: unknown, fallback: string, max = 4000) { return typeof value === 'string' ? value.slice(0, max) : fallback; }

export function resolveChatCompletionsUrl(value: string) {
  let url: URL;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('AI Base URL 格式无效'); }
  if (url.protocol !== 'https:') throw new Error('AI Base URL 必须使用 HTTPS');
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(?:compatible-mode\/)?v1$/i.test(path)) url.pathname = `${path}/chat/completions`;
  else if (!path) url.pathname = '/v1/chat/completions';
  else url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

class AiRequestError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = 'AiRequestError'; }
}

function readableFetchError(error: unknown, timeoutMs: number) {
  const value = error as Error & { cause?: { code?: string; message?: string } };
  const code = String(value?.cause?.code || ''); const detail = String(value?.cause?.message || value?.message || '');
  if (value?.name === 'AbortError') return new AiRequestError(`AI 请求超时（${timeoutMs}ms）`, true);
  if (/redirect count exceeded/i.test(detail)) return new AiRequestError('AI 接口发生重定向循环，请检查地址是否包含 /chat/completions', false);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AiRequestError(`AI 服务域名解析失败（${code}）`, true);
  if (code === 'ECONNREFUSED') return new AiRequestError('AI 服务拒绝连接', true);
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return new AiRequestError('连接 AI 服务超时', true);
  if (/certificate|tls|ssl/i.test(`${code} ${detail}`)) return new AiRequestError('AI 服务 TLS 证书验证失败', false);
  return new AiRequestError(`AI 网络请求失败${code ? `（${code}）` : ''}`, true);
}

function normalize(input: Record<string, unknown>, previous: AiConfig = defaultConfig): AiConfig {
  return {
    ...previous,
    provider: string(input.provider, previous.provider, 40), baseUrl: resolveChatCompletionsUrl(string(input.baseUrl, previous.baseUrl, 500)), model: string(input.model, previous.model, 160),
    temperature: number(input.temperature, previous.temperature, 0, 2), maxTokens: number(input.maxTokens, previous.maxTokens, 32, 4000),
    timeoutMs: number(input.timeoutMs, previous.timeoutMs, 5000, 180000), retries: number(input.retries, previous.retries, 0, 3),
    enableJudge: bool(input.enableJudge, previous.enableJudge), enableComments: bool(input.enableComments, previous.enableComments), enableRelay: bool(input.enableRelay, previous.enableRelay),
    judgePrompt: string(input.judgePrompt, previous.judgePrompt), commentPrompt: string(input.commentPrompt, previous.commentPrompt), relayPrompt: string(input.relayPrompt, previous.relayPrompt),
    fallbackComment: string(input.fallbackComment, previous.fallbackComment, 500), fallbackRelay: string(input.fallbackRelay, previous.fallbackRelay, 500),
    allowEmptyRelay: bool(input.allowEmptyRelay, previous.allowEmptyRelay), maxRequestsPerRun: number(input.maxRequestsPerRun, previous.maxRequestsPerRun, 1, 200),
    sensitiveWords: Array.isArray(input.sensitiveWords) ? input.sensitiveWords.filter(item => typeof item === 'string').map(item => item.slice(0, 80)).slice(0, 100) : previous.sensitiveWords
  };
}

function normalizeAccountOverride(input: Record<string, unknown>) {
  const override: Partial<Pick<AiConfig, AccountOverrideKey>> = {};
  for (const key of accountOverrideKeys) {
    if (!(key in input)) continue;
    if (key === 'commentPrompt' || key === 'relayPrompt') {
      const value = string(input[key], '').trim();
      if (value) override[key] = value;
    } else if (typeof input[key] === 'boolean') {
      override[key] = input[key];
    }
  }
  return override;
}

function publicConfig(config: AiConfig & { apiKeyConfigured?: boolean }) {
  const { apiKey, ...safe } = config;
  return { ...safe, apiKeyConfigured: Boolean(apiKey), apiKeyHint: apiKey ? `••••••${apiKey.slice(-4)}` : '' };
}

function render(template: string, variables: Record<string, string>) { return template.replace(/\{(dynamic_text|author|lottery_conditions|draw_time|account_name)\}/g, (_, key) => variables[key] || ''); }
function cleanContent(value: string, config: AiConfig) {
  const text = String(value || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 500);
  if (!text || config.sensitiveWords.some(word => word && text.includes(word))) return '';
  return text;
}

export class AiService {
  constructor(private db: AppDatabase) {
    const raw = this.db.getSetting('ai_global_config');
    if (raw) {
      try {
        const stored = JSON.parse(raw) as Record<string, unknown>;
        if (typeof stored.baseUrl === 'string') {
          const normalized = resolveChatCompletionsUrl(stored.baseUrl);
          if (normalized !== stored.baseUrl) this.db.setSetting('ai_global_config', JSON.stringify({ ...stored, baseUrl: normalized }));
        }
      } catch { /* invalid legacy settings fall back to defaults */ }
    }
  }
  listProviders() { return providers; }

  private readStored(): AiConfig {
    const raw = this.db.getSetting('ai_global_config');
    if (!raw) return { ...defaultConfig };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const config = normalize(parsed);
      if (typeof parsed.apiKeyEncrypted === 'string') { try { config.apiKey = decrypt(parsed.apiKeyEncrypted); } catch { config.apiKey = undefined; } }
      return config;
    } catch { return { ...defaultConfig }; }
  }

  private writeStored(config: AiConfig) {
    const raw: Record<string, unknown> = { ...config };
    delete raw.apiKey;
    if (config.apiKey) raw.apiKeyEncrypted = encrypt(config.apiKey);
    this.db.setSetting('ai_global_config', JSON.stringify(raw));
  }

  getGlobalPublic() { return publicConfig(this.readStored()); }
  saveGlobal(input: Record<string, unknown>) {
    const current = this.readStored();
    const next = normalize(input, current);
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) next.apiKey = input.apiKey.trim();
    if (input.clearApiKey === true) delete next.apiKey;
    this.writeStored(next);
    return publicConfig(this.readStored());
  }

  private accountOverride(accountId: number) {
    const config = this.db.getConfig(accountId) as Record<string, any>;
    return (config.ai && typeof config.ai === 'object') ? normalizeAccountOverride(config.ai as Record<string, unknown>) : {};
  }

  getAccountPublic(accountId: number) { return { ...this.accountOverride(accountId), inherited: true, apiKey: undefined }; }
  saveAccount(accountId: number, input: Record<string, unknown>) {
    const config = this.db.getConfig(accountId) as Record<string, any>;
    const ai = normalizeAccountOverride(input);
    this.db.setConfig(accountId, { ...config, ai });
    return this.getResolvedPublic(accountId);
  }

  resolve(accountId: number) {
    const global = this.readStored();
    const override = this.accountOverride(accountId);
    return normalize(override, global);
  }

  getResolvedPublic(accountId: number) { return publicConfig(this.resolve(accountId)); }

  async test(input: Record<string, unknown>, accountId?: number) {
    const useDraft = !accountId && input.useDraft === true;
    const config = accountId ? this.resolve(accountId) : useDraft ? normalize(input, this.readStored()) : this.readStored();
    if (useDraft && typeof input.apiKey === 'string' && input.apiKey.trim()) config.apiKey = input.apiKey.trim();
    if (!config.apiKey) throw new Error('请先配置 API Key');
    const content = string(input.content, '请回复：AI 连接测试成功。', 1000);
    const result = await this.complete(config, config.commentPrompt, content);
    return { ok: true, provider: config.provider, model: config.model, content: result };
  }

  async complete(config: AiConfig, systemPrompt: string, content: string) {
    const url = resolveChatCompletionsUrl(config.baseUrl);
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.retries; attempt += 1) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(url, { method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model: config.model, temperature: config.temperature, max_tokens: config.maxTokens, stream: false, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `<public_dynamic>\n${content.slice(0, 12000)}\n</public_dynamic>` }] }) });
        const body = await response.json().catch(() => ({})) as any;
        if (!response.ok) throw new AiRequestError(`AI 服务返回 ${response.status}: ${String(body.error?.message || body.message || '请求失败').slice(0, 200)}`, [408, 425, 429, 500, 502, 503, 504].includes(response.status));
        const output = body.choices?.[0]?.message?.content;
        if (typeof output !== 'string') throw new Error('AI 响应缺少文本内容');
        return cleanContent(output, config);
      } catch (error) {
        const readable = error instanceof AiRequestError ? error : error instanceof Error && !['TypeError', 'AbortError'].includes(error.name) ? new AiRequestError(error.message, false) : readableFetchError(error, config.timeoutMs);
        lastError = readable;
        if (!readable.retryable || attempt >= config.retries) break;
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
      finally { clearTimeout(timer); }
    }
    throw lastError instanceof Error ? lastError : new Error('AI 请求失败');
  }

  async generate(kind: 'comment' | 'relay' | 'judge', accountId: number, variables: Record<string, string>) {
    const config = this.resolve(accountId);
    const prompt = kind === 'judge' ? config.judgePrompt : kind === 'relay' ? config.relayPrompt : config.commentPrompt;
    const text = render(prompt, variables);
    return this.complete(config, text, variables.dynamic_text || '');
  }
}

export { defaultConfig as defaultAiConfig, publicConfig };
