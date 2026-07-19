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

/**
 * Reasoning models emit their chain-of-thought wrapped in <think>…</think>.
 * Some wrap it fully; others emit only the closing </think> (the opening tag is
 * implicit, so the reasoning is everything before it). Strip both shapes so
 * callers get just the answer. Text with no think tags is returned trimmed but
 * otherwise unchanged.
 */
export function stripThinkBlocks(text: string): string {
  if (!text) return text;
  // Remove complete <think>…</think> blocks.
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Handle a dangling closing tag (chain-of-thought with no opening <think>):
  // everything up to and including the final </think> is reasoning.
  const close = out.toLowerCase().lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  return out.trim();
}

/**
 * Rough prompt-token estimate without a client-side tokenizer. Uses chars/3
 * (English averages ~4 chars/token) so it slightly OVER-estimates the prompt —
 * that makes the output budget conservative, which is the safe direction.
 */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 3) + 4 * messages.length; // + small per-message chat-template overhead
}

/**
 * Clamp requested output tokens so prompt + output fit the server's advertised
 * context window. vLLM (and some others) hard-reject when max_tokens exceeds
 * max_model_len; this keeps every request valid. When the server advertises no
 * context length (maxModelLen undefined), the request is returned unchanged.
 */
export function clampMaxTokens(
  requested: number,
  maxModelLen: number | undefined,
  messages: ChatMessage[],
): number {
  if (!maxModelLen || maxModelLen <= 0) return requested;
  const MIN_OUTPUT = 16;
  const budget = maxModelLen - estimatePromptTokens(messages) - 64; // reserve prompt + headroom
  if (budget < MIN_OUTPUT) return MIN_OUTPUT;
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
}
