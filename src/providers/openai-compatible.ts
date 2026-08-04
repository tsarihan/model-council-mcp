/**
 * Covers: OpenAI, X.AI (Grok), vLLM, TRT-LLM, SGLang — all speak the OpenAI
 * Chat Completions API. The only difference is the base URL, auth header, and
 * which models are available via /v1/models.
 */
import OpenAI from 'openai';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import {
  ChatMessage, CompletionOptions, Provider, stripThinkBlocks, clampMaxTokens,
  DEFAULT_COMPLETION_TIMEOUT_MS, PROBE_IMAGE_BASE64, isTimeoutError,
} from './base.js';
import { CHALLENGE_PROMPT, verifyVisionChallenge } from '../vision-challenge.js';
import { OPENAI_EFFORTS, clampEffort } from './effort.js';

/**
 * The OpenAI SDK appends `/models`, `/chat/completions`, etc. to its baseURL, so
 * the baseURL must already include the API version segment. OpenAI/X.AI base
 * URLs carry `/v1`; self-hosted vLLM/SGLang/TRT-LLM are configured as bare
 * `host:port`, so append `/v1` when it's missing (they serve at /v1/*).
 */
export function openaiBaseURL(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/**
 * Build OpenAI's wire message shape: a message with images becomes multipart
 * content (a text part + one image_url part per image, each a `data:` URI); a
 * message with no images keeps the plain string form other servers expect.
 * Exported so the shape can be asserted directly in unit tests.
 */
export function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map(m => {
    if (m.role === 'user' && m.images?.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map(img => ({
            type: 'image_url' as const,
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
  });
}

export class OpenAICompatibleProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private client: OpenAI;
  /** Per-model advertised context window (max_model_len); null = not advertised. */
  private maxLenCache = new Map<string, number | null>();
  /** Per-model accept/reject probe result (stage 1). Only definitive answers are cached. */
  private acceptCache = new Map<string, boolean>();
  /** Per-model OCR-challenge-verified vision result (stage 2); only set once definitive. */
  private visionVerifiedCache = new Map<string, boolean>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.client = new OpenAI({
      baseURL: openaiBaseURL(config.baseUrl), // ensure the /v1 segment (self-hosted servers omit it)
      apiKey: config.apiKey ?? 'ollama', // vLLM/SGLang/TRT-LLM ignore the key
      // Retries are handled by completeWithRetry; the SDK's own default of 2
      // would multiply a hung-server timeout by 3×. Bound each call instead.
      maxRetries: 0,
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
    let listedOk = false;
    try {
      // Metadata call — keep it short so a wedged server can't stall the ask here.
      const list = await this.client.models.list({ timeout: 10_000 });
      for (const m of list.data as Array<{ id: string; max_model_len?: number }>) {
        this.maxLenCache.set(m.id, typeof m.max_model_len === 'number' ? m.max_model_len : null);
      }
      listedOk = true;
    } catch {
      /* unreachable / rate-limited → leave unknown, no clamp */
    }
    // Memoize the "server listed successfully but this model advertised no
    // max_model_len" case as null (a real, stable negative). But do NOT cache
    // null when the LISTING ITSELF failed (listedOk === false) — that's a
    // transient blip, and caching it would permanently disable clamping for the
    // process (re-exposing vLLM/SGLang's max_tokens hard-reject) with no retry.
    // Matches the Ollama provider's fetchShow discipline: cache only on success,
    // stay retryable on failure.
    if (listedOk && !this.maxLenCache.has(model)) this.maxLenCache.set(model, null);
    return this.maxLenCache.get(model) ?? undefined;
  }

  /**
   * Stage 1: does the endpoint even ACCEPT an image_url part? No
   * OpenAI-compatible endpoint (self-hosted or cloud) advertises vision
   * support via /v1/models, so the only generic way to find out is to send a
   * real request with an image part and see whether it's rejected. Cost is
   * negligible (max_tokens: 1, a 32×32 test image).
   *
   * Only a DEFINITIVE answer is cached: a clean 200 (true) or a 4xx that
   * genuinely rejects the request (false — the server validated and refused
   * the image part). A timeout/connection error, a rate limit (429), an
   * auth/permission failure (401/403), a request-conflict code (408/409), or
   * any error with no status at all is transient/uninformative about vision
   * support — each returns false for this call only, without poisoning the
   * cache.
   *
   * A "true" here only proves the endpoint accepts an image, not that the
   * model meaningfully attends to it — some servers accept and silently
   * ignore unsupported content parts (observed live with SGLang serving a
   * non-vision Qwen2.5-0.5B-Instruct). That's what stage 2 is for.
   */
  private async probeAcceptsImage(model: string): Promise<boolean> {
    const cached = this.acceptCache.get(model);
    if (cached !== undefined) return cached;
    try {
      await this.client.chat.completions.create(
        {
          model,
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '.' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
              ],
            },
          ],
        },
        { timeout: 15_000 },
      );
      this.acceptCache.set(model, true);
      return true;
    } catch (err) {
      if (isTimeoutError(err)) return false; // transient — don't cache
      const status = (err as { status?: number }).status;
      // Rate limiting, auth/permission failures, and request-conflict codes
      // say nothing about whether the MODEL accepts an image part — caching
      // any of these as a permanent rejection would silently exclude a
      // genuinely vision-capable model from every future image question for
      // the life of the process over a transient condition unrelated to
      // vision support. A response with NO status at all (ECONNRESET, DNS
      // failure, a malformed SDK error/shape) is equally uninformative.
      // 404 added here (round 5): almost always "endpoint/model not found"
      // (a deployment mid-rollout, a renamed/typo'd model) — nothing to do
      // with whether that model accepts an image part once actually
      // reachable. Caching it as a vision rejection would exclude a
      // genuinely capable model over an unrelated routing problem.
      const transientStatus = status === 429 || status === 401 || status === 403 || status === 404 || status === 408 || status === 409;
      if (transientStatus || typeof status !== 'number') return false; // transient — don't cache
      if (status >= 500) return false; // server error — don't cache
      this.acceptCache.set(model, false); // remaining 4xx → the server validated and refused the image part
      return false;
    }
  }

  /**
   * Two-stage detection. Stage 1 (above) is a trustworthy NEGATIVE but not a
   * trustworthy positive. Stage 2 behaviorally confirms a stage-1 "yes" with
   * an OCR challenge before it's trusted — this is what catches a server that
   * accepts an image request without the underlying model actually reading it.
   */
  async supportsVision(model: string): Promise<boolean> {
    const verified = this.visionVerifiedCache.get(model);
    if (verified !== undefined) return verified;

    const accepted = await this.probeAcceptsImage(model);
    if (!accepted) return false; // trustworthy negative, already cached above

    const outcome = await verifyVisionChallenge(async (challenge) => {
      // Clamp the challenge's max_tokens to the server's context the same way
      // complete() does — this is the one completion this provider issues that
      // otherwise sent an unclamped 2000, which vLLM/SGLang hard-reject on a
      // small-context model, so a genuinely vision-capable but small-context
      // model would never get confirmed. Account for the image (a ChatMessage
      // carrying the challenge image) so the reserve is realistic.
      let maxTokens: number;
      try {
        maxTokens = clampMaxTokens(2000, await this.maxModelLen(model), [
          { role: 'user', content: CHALLENGE_PROMPT, images: [{ base64: challenge.base64, mimeType: challenge.mimeType }] },
        ]);
      } catch {
        // Prompt (image) doesn't fit this model's context at all → can't verify
        // vision here; empty is treated as inconclusive (not a definitive fail).
        return '';
      }
      const res = await this.client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: CHALLENGE_PROMPT },
                { type: 'image_url', image_url: { url: `data:${challenge.mimeType};base64,${challenge.base64}` } },
              ],
            },
          ],
        },
        { timeout: 60_000 },
      );
      return stripThinkBlocks(res.choices[0]?.message?.content ?? '');
    });
    if (outcome === 'pass') { this.visionVerifiedCache.set(model, true); return true; }
    if (outcome === 'fail') { this.visionVerifiedCache.set(model, false); return false; }
    return false; // inconclusive — not cached, retried next call
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

    try {
      // Generous enough not to drop a slow-enumerating server, still bounded.
      const list = await this.client.models.list({ timeout: 30_000 });
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
    const wireMessages = toOpenAIMessages(messages);
    const body = {
      model,
      messages: wireMessages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: maxTokens,
      // Prefer schema-constrained decoding (OpenAI + vLLM/SGLang guided
      // decoding) over plain json_object, which only guarantees parseable JSON.
      ...(opts.jsonSchema
        ? { response_format: { type: 'json_schema' as const,
            json_schema: { name: 'council_judge', schema: opts.jsonSchema, strict: false } } }
        : opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };
    // Reasoning depth. OpenAI documents none/minimal/low/medium/high (newer
    // models add xhigh) — but this same provider also fronts vLLM / TRT-LLM /
    // SGLang, whose support varies by build and by model, and a non-reasoning
    // model rejects the parameter outright. So it goes on as a separate field
    // that can be dropped and retried (below) rather than failing the member.
    const effort = opts.effort ? clampEffort(opts.effort, OPENAI_EFFORTS) : undefined;
    const reqOpts = { timeout: opts.timeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS };

    let res;
    try {
      res = await this.client.chat.completions.create(
        // The pinned SDK's own `reasoning_effort` union predates the newer
        // levels (it types only low/medium/high), so the wider canonical value
        // is cast on. The WIRE is what matters here — this provider also fronts
        // vLLM/TRT-LLM/SGLang, whose accepted values aren't OpenAI's anyway —
        // and a server that rejects the value is already handled by the retry
        // below, so an out-of-date client-side type must not narrow what the
        // council can ask for.
        effort ? { ...body, reasoning_effort: effort as unknown as 'low' } : body,
        reqOpts,
      );
    } catch (err) {
      // Retry once WITHOUT the effort field when the server rejected that
      // field specifically (400 naming reasoning_effort / an unsupported or
      // unknown parameter). Mirrors the reactive max_tokens clamp in
      // anthropic.ts: an optional quality knob must never cost the council a
      // member. Anything else — auth, quota, timeout, a genuine bad request —
      // propagates unchanged, so real failures stay loud.
      const status = (err as { status?: number }).status;
      const msg = String((err as { message?: string })?.message ?? err);
      const rejectedEffort =
        effort !== undefined &&
        status === 400 &&
        /reasoning[_ ]?effort|unsupported parameter|unknown parameter|unrecognized/i.test(msg);
      if (!rejectedEffort) throw err;
      res = await this.client.chat.completions.create(body, reqOpts);
    }

    return stripThinkBlocks(res.choices[0]?.message?.content ?? '');
  }
}
