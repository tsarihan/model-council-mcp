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
