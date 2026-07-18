/**
 * Covers: OpenAI, Groq, vLLM, TRT-LLM, SGLang — all speak the OpenAI Chat
 * Completions API.  The only difference is the base URL, auth header, and
 * which models are available via /v1/models.
 */
import OpenAI from 'openai';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import {
  ChatMessage, CompletionOptions, Provider, stripThinkBlocks, clampMaxTokens,
} from './base.js';

// Known-static model lists for cloud providers that don't enumerate via API
// (OpenAI's /models endpoint returns many but we surface common ones)
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'llama3-70b-8192',
  'llama3-8b-8192',
];

/**
 * The OpenAI SDK appends `/models`, `/chat/completions`, etc. to its baseURL, so
 * the baseURL must already include the API version segment. OpenAI/Groq base
 * URLs carry `/v1`; self-hosted vLLM/SGLang/TRT-LLM are configured as bare
 * `host:port`, so append `/v1` when it's missing (they serve at /v1/*).
 */
export function openaiBaseURL(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

export class OpenAICompatibleProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private client: OpenAI;
  /** Per-model advertised context window (max_model_len); null = not advertised. */
  private maxLenCache = new Map<string, number | null>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.client = new OpenAI({
      baseURL: openaiBaseURL(config.baseUrl), // ensure the /v1 segment (self-hosted servers omit it)
      apiKey: config.apiKey ?? 'ollama', // vLLM/SGLang/TRT-LLM ignore the key
    });
  }

  /**
   * The server's advertised context window for `model`, from /v1/models
   * (vLLM and SGLang expose `max_model_len`; others omit it). Cached per model;
   * returns undefined when unknown so callers skip clamping.
   */
  private async maxModelLen(model: string): Promise<number | undefined> {
    const cached = this.maxLenCache.get(model);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const list = await this.client.models.list();
      for (const m of list.data as Array<{ id: string; max_model_len?: number }>) {
        this.maxLenCache.set(m.id, typeof m.max_model_len === 'number' ? m.max_model_len : null);
      }
    } catch {
      /* unreachable / rate-limited → leave unknown, no clamp */
    }
    if (!this.maxLenCache.has(model)) this.maxLenCache.set(model, null);
    return this.maxLenCache.get(model) ?? undefined;
  }

  async ping(): Promise<boolean> {
    try {
      // Most OpenAI-compatible servers expose /models
      const url = new URL('/v1/models', this.config.baseUrl);
      const res = await fetch(url.toString(), {
        headers: this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {},
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const type = this.config.type;

    // Groq: return curated list (their /models endpoint is rate-limited)
    if (type === 'groq') {
      return GROQ_MODELS.map(m => ({
        provider: 'groq' as ProviderType,
        model: m,
        label: m,
      }));
    }

    try {
      const list = await this.client.models.list();
      return list.data.map(m => ({
        provider: type as ProviderType,
        serverId: this.serverId === type ? undefined : this.serverId,
        model: m.id,
        label: m.id,
      }));
    } catch {
      return [];
    }
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    opts: CompletionOptions = {},
  ): Promise<string> {
    // Clamp to the server's advertised context so a large default max_tokens
    // (e.g. 16000) doesn't get hard-rejected by servers like vLLM.
    const maxTokens = clampMaxTokens(opts.maxTokens ?? 16000, await this.maxModelLen(model), messages);
    const res = await this.client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: maxTokens,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    return stripThinkBlocks(res.choices[0]?.message?.content ?? '');
  }
}
