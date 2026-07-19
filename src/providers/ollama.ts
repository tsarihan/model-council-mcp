import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import {
  ChatMessage, CompletionOptions, Provider, stripThinkBlocks, clampMaxTokens,
  DEFAULT_COMPLETION_TIMEOUT_MS,
} from './base.js';

/** What we read out of a single /api/show call — cached together so context
 *  length and vision capability never need two separate round trips. */
interface ShowInfo {
  ctxLen: number | null;
  vision: boolean;
}

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

interface OllamaWireMessage {
  role: string;
  content: string;
  images?: string[];
}

/**
 * Build Ollama's wire message shape: images are a sibling `images` array of
 * bare base64 strings (NOT `data:` URIs, and NOT nested inside `content`) —
 * getting this wrong is exactly the "garbled data" failure mode. Exported so
 * the shape can be asserted directly in unit tests without a live server.
 */
export function toOllamaMessages(messages: ChatMessage[]): OllamaWireMessage[] {
  return messages.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.images?.length ? { images: m.images.map(img => img.base64) } : {}),
  }));
}

export class OllamaProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  /** Per-model /api/show result (context length + vision capability); undefined = not yet fetched. */
  private showCache = new Map<string, ShowInfo>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
  }

  /**
   * Fetch and cache /api/show for `model` once, extracting both the advertised
   * context length (`model_info`'s arch-prefixed `*.context_length`) and the
   * `capabilities` array (vision support shows up as `"vision"`). A transient
   * failure (unreachable host) is NOT cached, so a network blip doesn't
   * permanently mislabel a model — it's simply retried on the next call.
   */
  private async fetchShow(model: string): Promise<ShowInfo> {
    const cached = this.showCache.get(model);
    if (cached) return cached;
    const res = await fetch(`${this.config.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Ollama /api/show failed (${res.status})`);
    const data = (await res.json()) as {
      model_info?: Record<string, unknown>;
      capabilities?: unknown;
    };
    const info = data.model_info ?? {};
    const key = Object.keys(info).find(k => k.endsWith('.context_length'));
    const ctxLen = key && typeof info[key] === 'number' ? (info[key] as number) : null;
    const vision = Array.isArray(data.capabilities) && data.capabilities.includes('vision');
    const result: ShowInfo = { ctxLen, vision };
    this.showCache.set(model, result);
    return result;
  }

  /**
   * The model's advertised context length. Undefined when unknown (e.g. Ollama
   * cloud models, or the host is unreachable) so callers skip clamping.
   */
  private async modelContextLen(model: string): Promise<number | undefined> {
    try {
      return (await this.fetchShow(model)).ctxLen ?? undefined;
    } catch {
      return undefined; // unreachable → leave unknown, no clamp
    }
  }

  async supportsVision(model: string): Promise<boolean> {
    try {
      return (await this.fetchShow(model)).vision;
    } catch {
      return false; // unreachable → treat as not vision-capable for this call only
    }
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
    // Bounded so an unresponsive Ollama host can't hang list_models / auto-discovery,
    // but generous enough not to drop a host that's slow to enumerate many models.
    const res = await fetch(`${this.config.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(30_000),
    });
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
    const wireMessages = toOllamaMessages(messages);
    const body = {
      model,
      messages: wireMessages,
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
      // Bound a wedged host/model so one member can't stall the whole ask.
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama complete failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    // Guard the dereference: a non-Ollama or error-shaped 200 body may lack
    // `message`, which would otherwise throw an opaque TypeError.
    return stripThinkBlocks(data?.message?.content ?? '');
  }
}
