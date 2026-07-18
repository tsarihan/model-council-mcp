import { ModelInfo, ServerConfig } from '../types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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
}
