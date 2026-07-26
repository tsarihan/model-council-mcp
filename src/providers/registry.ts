import { ModelId, ServerConfig } from '../types.js';
import { Provider } from './base.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { CodexCliProvider } from './codex-cli.js';
import { GrokCliProvider } from './grok-cli.js';

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
        case 'claude-cli':
          provider = new ClaudeCliProvider(srv);
          break;
        case 'codex-cli':
          provider = new CodexCliProvider(srv);
          break;
        case 'grok-cli':
          provider = new GrokCliProvider(srv);
          break;
        case 'openai':
        case 'xai':
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
      // The bare-serverId fallback can collide with an UNRELATED provider's
      // own registered id — e.g. "ollama/codex-cli:llama3" (provider
      // "ollama", serverId "codex-cli") falls through to
      // providers.get("codex-cli"), which is the ACTUAL codex-cli provider's
      // own id in this codebase. Without this check that mistyped/ambiguous
      // model id would silently resolve to (and spend quota on) codex-cli
      // instead of failing clearly or resolving to ollama.
      if (explicit && explicit.config.type !== modelId.provider) return null;
      return explicit ?? null;
    }
    // Default: find the first provider of the matching type — but NEVER a
    // claude-cli server backed by a non-Anthropic endpoint (the Ollama harness,
    // config.anthropicBaseUrl set). Two claude-cli servers can now coexist (the
    // real subscription CLI + the harness); a bare, serverId-less `claude-cli:*`
    // id must only ever reach the real subscription server, so the harness is
    // addressable ONLY by its explicit serverId. Without this skip, a bare id
    // could resolve to the harness whenever it appears first — or when the
    // subscription server is absent (e.g. a tier downgrade leaving a stale
    // persisted `claude-cli:opus` member) — silently POSTing the prompt to the
    // wrong backend under a label that conceals the swap.
    return (
      [...this.providers.values()].find(
        // Read the TRIMMED value so this agrees with buildChildEnv / the
        // constructor / poolKey (all treat a whitespace-only anthropicBaseUrl
        // as absent = subscription). Reading it untrimmed here would make a
        // whitespace-only value be skipped-as-harness by resolve() yet treated
        // as subscription everywhere else — the exact cross-file divergence
        // this field's handling is meant to avoid.
        p => p.config.type === modelId.provider && !p.config.anthropicBaseUrl?.trim(),
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
