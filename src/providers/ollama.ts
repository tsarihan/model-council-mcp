import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import {
  ChatMessage, CompletionOptions, Provider, stripThinkBlocks, clampMaxTokens,
} from './base.js';

interface OllamaModel {
  name: string;
  details?: {
    parameter_size?: string;
    family?: string;
  };
  size?: number;
}

interface OllamaListResponse {
  models: OllamaModel[];
}

interface OllamaChatResponse {
  message: { content: string };
}

export class OllamaProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  /** Per-model advertised context length (from /api/show); null = unknown. */
  private ctxLenCache = new Map<string, number | null>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
  }

  /**
   * The model's advertised context length from /api/show (`model_info` holds an
   * arch-prefixed `*.context_length`). Cached per model; undefined when unknown
   * (e.g. Ollama cloud models) so callers skip clamping.
   */
  private async modelContextLen(model: string): Promise<number | undefined> {
    const cached = this.ctxLenCache.get(model);
    if (cached !== undefined) return cached ?? undefined;
    let len: number | null = null;
    try {
      const res = await fetch(`${this.config.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
        const key = Object.keys(info).find(k => k.endsWith('.context_length'));
        if (key && typeof info[key] === 'number') len = info[key] as number;
      }
    } catch {
      /* unreachable → leave unknown, no clamp */
    }
    this.ctxLenCache.set(model, len);
    return len ?? undefined;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.config.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama list failed: ${res.status}`);
    const data = (await res.json()) as OllamaListResponse;

    return (data.models ?? []).map(m => ({
      provider: 'ollama' as ProviderType,
      serverId: this.serverId === 'ollama' ? undefined : this.serverId,
      model: m.name,
      label: m.name,
      paramSize: m.details?.parameter_size,
      family: m.details?.family,
      diskBytes: m.size,
    }));
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    opts: CompletionOptions = {},
  ): Promise<string> {
    const numPredict = clampMaxTokens(
      opts.maxTokens ?? 16000, await this.modelContextLen(model), messages,
    );
    const body = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: numPredict,
      },
      ...(opts.jsonMode ? { format: 'json' } : {}),
    };

    const res = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama complete failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return stripThinkBlocks(data.message.content);
  }
}
