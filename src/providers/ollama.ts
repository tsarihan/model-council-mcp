import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import {
  ChatMessage, CompletionOptions, Provider, stripThinkBlocks, clampMaxTokens,
  DEFAULT_COMPLETION_TIMEOUT_MS,
} from './base.js';
import { CHALLENGE_PROMPT, verifyVisionChallenge } from '../vision-challenge.js';
import { OLLAMA_EFFORTS, clampEffort } from './effort.js';

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
  /** Per-model OCR-challenge-verified vision result; only set once definitive. */
  private visionVerifiedCache = new Map<string, boolean>();

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

  /**
   * Two-stage detection. Stage 1 (`/api/show` capabilities) is a trustworthy
   * NEGATIVE but not a trustworthy positive — custom/quantized model builds
   * (MLX conversions, GGUF imports) can drop the vision projector while still
   * reporting `"vision"` in capabilities (documented upstream: unsloth#2290,
   * ollama#9967; reproduced live with a local `-mlx` build that claimed vision
   * but denied ever receiving an image). Stage 2 behaviorally confirms a
   * stage-1 "yes" with an OCR challenge before it's trusted.
   */
  async supportsVision(model: string): Promise<boolean> {
    let metadataVision: boolean;
    try {
      metadataVision = (await this.fetchShow(model)).vision;
    } catch {
      return false; // unreachable → not vision-capable for this call only, not cached
    }
    if (!metadataVision) return false; // trustworthy negative, already cached by fetchShow

    const cached = this.visionVerifiedCache.get(model);
    if (cached !== undefined) return cached;

    const outcome = await verifyVisionChallenge((challenge) =>
      this.complete(
        model,
        [{ role: 'user', content: CHALLENGE_PROMPT, images: [{ base64: challenge.base64, mimeType: challenge.mimeType }] }],
        { maxTokens: 2000, timeoutMs: 60_000 },
      ),
    );
    if (outcome === 'pass') { this.visionVerifiedCache.set(model, true); return true; }
    if (outcome === 'fail') { this.visionVerifiedCache.set(model, false); return false; }
    return false; // inconclusive (transport error/empty on both attempts) — not cached, retried next call
  }

  getVisionCache(): Record<string, boolean> {
    return Object.fromEntries(this.visionVerifiedCache);
  }

  seedVisionCache(entries: Record<string, boolean>): void {
    for (const [model, vision] of Object.entries(entries)) {
      if (!this.visionVerifiedCache.has(model)) this.visionVerifiedCache.set(model, vision);
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
      // Reasoning depth. Ollama's scale is low/medium/high/max plus the
      // booleans (verified against 0.32.5's own error message), so `none` maps
      // to `think: false` — an explicit "don't think", not an omitted field —
      // and minimal/xhigh clamp to their nearest neighbours.
      ...(opts.effort
        ? { think: opts.effort === 'none' ? false : clampEffort(opts.effort, OLLAMA_EFFORTS) }
        : {}),
      // A schema (when supplied) constrains decoding; plain 'json' is the
      // weaker fallback. NOTE: Ollama :cloud models ignore `format` entirely
      // (measured), so the caller's parse+shape guard remains the real backstop.
      ...(opts.jsonSchema ? { format: opts.jsonSchema } : opts.jsonMode ? { format: 'json' } : {}),
    };

    const post = (payload: object): Promise<Response> =>
      fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // Bound a wedged host/model so one member can't stall the whole ask.
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS),
      });

    let res = await post(body);

    if (!res.ok && 'think' in body) {
      // Not every Ollama model can think, and one that can't rejects the field
      // outright ("model does not support thinking"). Dropping a member over an
      // OPTIONAL quality knob is the wrong trade — a council-wide effort
      // setting must not silently shrink the council to its reasoning models —
      // so retry once without it and let the model answer at its own depth.
      // Deliberately narrow: only a 4xx whose body actually names thinking
      // retries, so a genuine 500/timeout/quota refusal still surfaces
      // unchanged (and is not doubled up into two failing round trips).
      const text = await res.text();
      if (res.status >= 400 && res.status < 500 && /think/i.test(text)) {
        const { think: _dropped, ...withoutThink } = body as typeof body & { think?: unknown };
        res = await post(withoutThink);
      } else {
        const err = new Error(`Ollama complete failed (${res.status}): ${text}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
    }

    if (!res.ok) {
      const text = await res.text();
      // Attach the HTTP status: a plain Error hides it in the message, so
      // status-based classification (429 throttling vs a permanent refusal)
      // could not see it at all.
      const err = new Error(`Ollama complete failed (${res.status}): ${text}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as OllamaChatResponse;
    // Guard the dereference: a non-Ollama or error-shaped 200 body may lack
    // `message`, which would otherwise throw an opaque TypeError.
    return stripThinkBlocks(data?.message?.content ?? '');
  }
}
