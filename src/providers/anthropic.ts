import Anthropic from '@anthropic-ai/sdk';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { ChatMessage, CompletionOptions, Provider } from './base.js';

// Curated list — Anthropic's REST API has no model-listing endpoint
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-5',    label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5',  label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-0',    label: 'Claude Opus 4.0' },
  { id: 'claude-sonnet-4-0',  label: 'Claude Sonnet 4.0' },
  { id: 'claude-haiku-4-0',   label: 'Claude Haiku 4.0' },
];

export class AnthropicProvider implements Provider {
  readonly serverId = 'anthropic';
  readonly config: ServerConfig;
  private client: Anthropic;

  constructor(config: ServerConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async ping(): Promise<boolean> {
    try {
      // Cheap sanity: just check we can hit the base URL
      const res = await fetch('https://api.anthropic.com', {
        signal: AbortSignal.timeout(5000),
      });
      // 404 is fine — it means the server is up
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return ANTHROPIC_MODELS.map(m => ({
      provider: 'anthropic' as ProviderType,
      model: m.id,
      label: m.label,
    }));
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    opts: CompletionOptions = {},
  ): Promise<string> {
    // Anthropic treats 'system' messages separately
    const systemParts = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');

    const userMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Append JSON instruction to system if needed — Anthropic has no json_object mode
    const systemText = opts.jsonMode
      ? `${systemParts}\n\nRespond with valid JSON only.`.trim()
      : systemParts || undefined;

    const res = await this.client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      ...(systemText ? { system: systemText } : {}),
      messages: userMessages,
    });

    const block = res.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}
