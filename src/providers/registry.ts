import { ModelId, ServerConfig } from '../types.js';
import { Provider } from './base.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  constructor(servers: ServerConfig[]) {
    for (const srv of servers) {
      let provider: Provider;
      switch (srv.type) {
        case 'ollama':
          provider = new OllamaProvider(srv);
          break;
        case 'anthropic':
          provider = new AnthropicProvider(srv);
          break;
        case 'openai':
        case 'groq':
        case 'vllm':
        case 'trtllm':
        case 'sglang':
          provider = new OpenAICompatibleProvider(srv);
          break;
        default:
          continue;
      }
      this.providers.set(srv.id, provider);
    }
  }

  /**
   * Resolve a ModelId to its provider.
   * serverId takes precedence; falls back to matching by type.
   */
  resolve(modelId: ModelId): Provider | null {
    if (modelId.serverId) {
      // e.g. vllm/vllm-gpu1 → id "vllm-vllm-gpu1"
      const explicit =
        this.providers.get(`${modelId.provider}-${modelId.serverId}`) ??
        this.providers.get(modelId.serverId);
      return explicit ?? null;
    }
    // Default: find the first provider of the matching type
    return (
      [...this.providers.values()].find(
        p => p.config.type === modelId.provider,
      ) ?? null
    );
  }

  getAll(): Provider[] {
    return [...this.providers.values()];
  }

  get(serverId: string): Provider | undefined {
    return this.providers.get(serverId);
  }
}
