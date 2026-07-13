/**
 * Covers: OpenAI, Groq, vLLM, TRT-LLM, SGLang — all speak the OpenAI Chat
 * Completions API.  The only difference is the base URL, auth header, and
 * which models are available via /v1/models.
 */
import OpenAI from 'openai';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { ChatMessage, CompletionOptions, Provider } from './base.js';

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

export class OpenAICompatibleProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private client: OpenAI;

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey ?? 'ollama', // vLLM/SGLang/TRT-LLM ignore the key
    });
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
    const res = await this.client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    return res.choices[0]?.message?.content ?? '';
  }
}
