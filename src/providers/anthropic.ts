import Anthropic from '@anthropic-ai/sdk';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { ChatMessage, CompletionOptions, Provider, PROBE_IMAGE_BASE64, isTimeoutError } from './base.js';
import { CHALLENGE_PROMPT, verifyVisionChallenge } from '../vision-challenge.js';

// Curated list — Anthropic's REST API has no model-listing endpoint
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-4-5',    label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5',  label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5',   label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-0',    label: 'Claude Opus 4.0' },
  { id: 'claude-sonnet-4-0',  label: 'Claude Sonnet 4.0' },
  { id: 'claude-haiku-4-0',   label: 'Claude Haiku 4.0' },
];

/**
 * Build Anthropic's wire message shape: a message with images becomes a
 * content-block array — image blocks (base64 + bare media_type, NOT a `data:`
 * URI) before the text block, per Anthropic's documented ordering; a message
 * with no images keeps the plain string form. Exported so the shape can be
 * asserted directly in unit tests.
 */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'user' && m.images?.length) {
        return {
          role: 'user' as const,
          content: [
            ...m.images.map(img => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mimeType, data: img.base64 },
            })),
            { type: 'text' as const, text: m.content },
          ],
        };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });
}

export class AnthropicProvider implements Provider {
  readonly serverId = 'anthropic';
  readonly config: ServerConfig;
  private client: Anthropic;
  /** Per-model accept/reject probe result (stage 1). Only definitive answers are cached. */
  private acceptCache = new Map<string, boolean>();
  /** Per-model OCR-challenge-verified vision result (stage 2); only set once definitive. */
  private visionVerifiedCache = new Map<string, boolean>();

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

  /**
   * Stage 1 (the Anthropic API has no capability-listing endpoint): send a
   * 1-token request with an image block and see whether it's accepted. Only a
   * definitive answer (200 or a 4xx rejection) is cached; a transient failure
   * (timeout/5xx) returns false for this call only.
   */
  private async probeAcceptsImage(model: string): Promise<boolean> {
    const cached = this.acceptCache.get(model);
    if (cached !== undefined) return cached;
    try {
      await this.client.messages.create({
        model,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PROBE_IMAGE_BASE64 } },
              { type: 'text', text: '.' },
            ],
          },
        ],
      });
      this.acceptCache.set(model, true);
      return true;
    } catch (err) {
      if (isTimeoutError(err)) return false; // transient — don't cache
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 500) return false; // server error — don't cache
      this.acceptCache.set(model, false); // 4xx → definitive rejection
      return false;
    }
  }

  /**
   * Two-stage detection. Every current Claude model is vision-capable, so
   * this should always resolve true — but it stays a real behavioral check
   * rather than a hardcoded assumption, for consistency with the other
   * providers and to stay correct if that ever changes.
   */
  async supportsVision(model: string): Promise<boolean> {
    const verified = this.visionVerifiedCache.get(model);
    if (verified !== undefined) return verified;

    const accepted = await this.probeAcceptsImage(model);
    if (!accepted) return false;

    const outcome = await verifyVisionChallenge((challenge) =>
      this.complete(
        model,
        [{ role: 'user', content: CHALLENGE_PROMPT, images: [{ base64: challenge.base64, mimeType: challenge.mimeType }] }],
        { maxTokens: 2000, timeoutMs: 60_000 },
      ),
    );
    if (outcome === 'pass') { this.visionVerifiedCache.set(model, true); return true; }
    if (outcome === 'fail') { this.visionVerifiedCache.set(model, false); return false; }
    return false; // inconclusive — not cached, retried next call
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

    const userMessages = toAnthropicMessages(messages);

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
