import { ModelInfo, ServerConfig } from '../types.js';

/** A single image attached to a user message, decoded to base64 + its MIME type. */
export interface ChatImage {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Images attached to this message (user messages only). Providers that don't
   *  support vision simply never read this field, so it is always safe to set —
   *  the real guarantee against sending images to a non-vision model is that the
   *  orchestrator only attaches `images` to members already confirmed vision-capable. */
  images?: ChatImage[];
}

/**
 * A small (32×32), hand-built, metadata-free PNG used to functionally probe
 * whether a model/endpoint accepts image input. Deliberately NOT 1×1 — some
 * vision preprocessors enforce a minimum decoded size and would reject a 1×1
 * image even on a genuinely vision-capable model, producing a false negative.
 */
export const PROBE_IMAGE_BASE64 =
  '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';

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** If true, response MUST be valid JSON */
  jsonMode?: boolean;
  /** Per-attempt wall-clock timeout (ms). Bounds a hung server/subprocess. */
  timeoutMs?: number;
  /**
   * Absolute repo root to grant repo exploration access to, for the CLI
   * providers that support it — enforced DIFFERENTLY per provider:
   *   - claude-cli: Read/Grep/Glob CONFINED to this root via --add-dir, a
   *     real enforced boundary (verified empirically — a Read attempt
   *     outside it is denied by the CLI itself).
   *   - codex-cli: --cd points its working root here, but its read-only
   *     sandbox does NOT confine reads to it — it can read any file the OS
   *     user can read, anywhere on the machine (verified live; this is
   *     pre-existing codex-cli behavior, not added by this option — only
   *     writes are blocked, everywhere, regardless of this value).
   * Undefined (the default) keeps a provider fully locked down as before.
   * Providers that don't support this (everything except claude-cli/
   * codex-cli) simply ignore it — they have no filesystem/tool concept to
   * grant in the first place.
   */
  fullRepoAccess?: string;
}

/** Default per-attempt completion timeout when a caller supplies none. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;

/** Whether an error looks like a request/subprocess timeout (so callers can skip retrying it). */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'APIConnectionTimeoutError') return true;
  return /\btimed out\b|\btimeout\b/i.test(String((err as { message?: string }).message ?? err));
}

/** Ceiling for a single CLI subprocess's accumulated stdout/stderr — see CappedBuffer. */
export const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Accumulates a spawned CLI subprocess's stdout/stderr with a hard ceiling, so
 * a runaway or misbehaving configured executable (a bad `--command`/`_PATH`
 * override, or one that goes into an infinite-output loop) can't grow an
 * unbounded in-memory string and exhaust server memory the way `str += chunk`
 * does with no cap. Every legitimate response here is bounded well under this
 * ceiling by `maxTokens`; once hit, further chunks are silently dropped rather
 * than killing the process — the caller's existing JSON-parse/shape checks
 * already turn truncated output into a clear error.
 */
export class CappedBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private readonly cap: number;

  constructor(cap: number = MAX_CLI_OUTPUT_BYTES) {
    this.cap = cap;
  }

  append(chunk: string): void {
    if (this.bytes >= this.cap) return;
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    // A single chunk larger than the remaining budget must be TRUNCATED, not
    // appended whole — otherwise one oversized chunk (a CLI can write however
    // much it wants to a pipe in one write()) blows straight past the cap,
    // silently defeating the "hard" bound this class exists to guarantee.
    if (this.bytes + chunkBytes <= this.cap) {
      this.chunks.push(chunk);
      this.bytes += chunkBytes;
      return;
    }
    const remaining = this.cap - this.bytes;
    // Slice by BYTES, not JS string length (chunk may contain multi-byte
    // UTF-8 chars) — truncate at the last full character boundary.
    const buf = Buffer.from(chunk, 'utf8').subarray(0, remaining);
    this.chunks.push(buf.toString('utf8'));
    this.bytes = this.cap;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

/**
 * Reasoning models emit their chain-of-thought wrapped in a reasoning tag.
 * Some wrap it fully; others emit only the closing tag (the opening is implicit,
 * so the reasoning is everything before it). Strip both shapes so callers get
 * just the answer. Text with no such tag is returned trimmed but unchanged.
 *
 * Covers the two tag names actually seen in the wild — `<think>` (DeepSeek,
 * Qwen, nemotron, most local reasoners) and `<thinking>` (Anthropic-style, some
 * OpenAI-compatible builds) — since a member that emits `<thinking>…</thinking>`
 * inline in its content would otherwise leak its whole chain-of-thought into the
 * answer shown to the council. (Ollama returns reasoning in a separate
 * `message.thinking` field, handled at that layer, not here.)
 */
const REASON_TAG = 'think|thinking';
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  // Remove complete <tag>…</tag> blocks (tag name matched case-insensitively).
  let out = text.replace(new RegExp(`<(?:${REASON_TAG})>[\\s\\S]*?</(?:${REASON_TAG})>`, 'gi'), '');
  // Handle a dangling closing tag (chain-of-thought with no opening tag):
  // everything up to and including the final closing tag is reasoning.
  const m = out.match(new RegExp(`</(?:${REASON_TAG})>(?![\\s\\S]*</(?:${REASON_TAG})>)`, 'i'));
  if (m && m.index !== undefined) out = out.slice(m.index + m[0].length);
  return out.trim();
}

/**
 * Extract a single JSON object from model output that may wrap it in prose or a
 * markdown fence. Finds the FIRST `{` and its BALANCED matching `}` — respecting
 * string literals and escapes — rather than the last `}` in the whole string.
 * A judge that appends explanatory text CONTAINING a brace (e.g. "…{json}\nLet
 * me know if you'd like {more}") is a common, reproducible behaviour that the
 * old `indexOf('{')..lastIndexOf('}')` slice would over-capture, breaking
 * JSON.parse and spuriously degrading an otherwise-valid judge result. Falls
 * back to the widest slice if no balanced object is found (a genuinely truncated
 * object still gets its best chance).
 */
/**
 * Throw unless `v` is a plain object carrying at least one of `keys`. jsonMode
 * (where it exists) only guarantees PARSEABLE JSON, not the expected SHAPE — and
 * the default CLI judges have no structured-output mode at all — so a judge can
 * return valid JSON of the wrong shape: a wrapper `{"analysis":{…}}`, a bare
 * array `[{…}]` (from which sliceBalancedJson extracts the first inner object),
 * or a scalar. All of those have the expected top-level fields as `undefined`,
 * so a parser that only guards FIELD types would coerce every field to empty and
 * report a fabricated 100%-consensus result with NO judgeDegraded flag — the
 * exact class judgeDegraded exists to catch. Throwing here routes such output
 * through each caller's existing judge-failure fallback instead.
 */
export function assertJsonShape(v: unknown, keys: string[]): void {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !keys.some(k => k in (v as object))) {
    throw new Error('judge JSON has an unexpected top-level shape');
  }
}

export function sliceBalancedJson(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  const end = text.lastIndexOf('}');
  return end > start ? text.slice(start, end + 1) : text;
}

/**
 * Conservative per-attached-image token reserve. A vision model consumes real
 * prompt/vision tokens for each image that plain char-counting can't see, so an
 * image-bearing request would otherwise under-estimate the prompt and let
 * clampMaxTokens over-allocate the output budget — which vLLM/SGLang hard-reject
 * when prompt+max_tokens exceeds max_model_len. ~1500 covers a typical single
 * high-detail image while staying small enough that one image against an 8k
 * context still leaves ample output room (never spuriously trips
 * PromptTooLargeError). It's an estimate in the same rough spirit as chars/3,
 * erring high (the safe direction), not an exact tokenizer.
 */
const IMAGE_TOKEN_ESTIMATE = 1500;

/**
 * Rough prompt-token estimate without a client-side tokenizer. Uses chars/3
 * (English averages ~4 chars/token) so it slightly OVER-estimates the text —
 * that makes the output budget conservative, which is the safe direction — plus
 * a per-image reserve so attached images (which cost real prompt tokens a char
 * count can't see) are accounted for too.
 */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  const imageCount = messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
  return Math.ceil(chars / 3) + 4 * messages.length + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Clamp requested output tokens so prompt + output fit the server's advertised
 * context window. vLLM (and some others) hard-reject when max_tokens exceeds
 * max_model_len; this keeps every request valid. When the server advertises no
 * context length (maxModelLen undefined), the request is returned unchanged.
 */
/** Thrown by clampMaxTokens when a prompt already exceeds a model's context window. */
export class PromptTooLargeError extends Error {
  constructor(message = 'prompt exceeds the model\'s context window') {
    super(message);
    this.name = 'PromptTooLargeError';
  }
}

export function clampMaxTokens(
  requested: number,
  maxModelLen: number | undefined,
  messages: ChatMessage[],
): number {
  if (!maxModelLen || maxModelLen <= 0) return requested;
  const MIN_OUTPUT = 16;
  const budget = maxModelLen - estimatePromptTokens(messages) - 64; // reserve prompt + headroom
  // A budget below a usable output floor means the prompt itself already
  // doesn't fit — silently sending the request anyway with a token-starved
  // MIN_OUTPUT max_tokens produces a response so truncated it's unusable,
  // contradicting this function's job of keeping requests valid. Reject
  // clearly instead so the caller surfaces "prompt too large" rather than a
  // mysteriously truncated/garbled answer.
  if (budget < MIN_OUTPUT) {
    throw new PromptTooLargeError(
      `prompt (~${estimatePromptTokens(messages)} tokens) leaves no room for a response within the model's ${maxModelLen}-token context window`,
    );
  }
  return Math.min(requested, budget);
}

export interface Provider {
  readonly serverId: string;
  readonly config: ServerConfig;

  /** List models available on this server */
  listModels(): Promise<ModelInfo[]>;

  /** Single completion call */
  complete(
    model: string,
    messages: ChatMessage[],
    opts?: CompletionOptions,
  ): Promise<string>;

  /** Quick reachability check */
  ping(): Promise<boolean>;

  /**
   * Whether `model` accepts image input. Cached per model where the answer is
   * definitive; a transient probe failure (unreachable/timeout) returns false
   * for that call without poisoning the cache, so a network blip doesn't
   * permanently mislabel a vision model as text-only.
   */
  supportsVision(model: string): Promise<boolean>;

  /**
   * The current DEFINITIVE vision-capability results, keyed by bare model
   * name — never includes a transient/inconclusive result (those are
   * deliberately never cached at all, see supportsVision). Read by the
   * orchestrator to persist verified capability to disk so a restart doesn't
   * re-pay the detection round trip for a model already proven capable.
   */
  getVisionCache(): Record<string, boolean>;

  /**
   * Seed the vision-capability cache from persisted state. Never overwrites
   * an existing in-memory entry — a fresh result computed earlier this
   * session always wins over a stale disk value.
   */
  seedVisionCache(entries: Record<string, boolean>): void;
}
