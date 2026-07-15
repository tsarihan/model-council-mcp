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
