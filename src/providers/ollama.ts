import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { ChatMessage, CompletionOptions, Provider, stripThinkBlocks } from './base.js';

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

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
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
    const body = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.maxTokens ?? 16000,
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
