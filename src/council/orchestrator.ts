/**
 * Top-level council orchestrator.
 * Dispatches to individual / categorized / deconflicted modes.
 */
import {
  CategorizedResult,
  CouncilConfig,
  CouncilResult,
  DeconflictedResult,
  IndividualResult,
  ModelId,
  ModelInfo,
  ResponseMode,
  RuntimeConfig,
} from '../types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { modelIdLabel } from '../config.js';
import { categorize } from './categorizer.js';
import { deconflict } from './deconflict.js';
import { runDialectic } from './dialectic.js';
import { runPooled } from './pool.js';
import { queryMembers } from './query.js';

// ─── Model classification ──────────────────────────────────────────────────────

/** Embedding-only models can't participate in a chat council. */
export function isEmbeddingModel(m: ModelInfo): boolean {
  if (m.family && /^(bert|nomic-bert)$/i.test(m.family)) return true;
  return /(^|[-_/])(embed|embedding|bge|nomic-embed|gte|e5|arctic-embed|mxbai-embed)([-_:/]|$)/i.test(
    m.model,
  );
}

// ─── Judge selection ──────────────────────────────────────────────────────────

function selectJudge(
  judgeModelId: ModelId | undefined,
  memberIds: ModelId[],
  allModels: ModelInfo[],
): ModelId | null {
  if (judgeModelId) return judgeModelId;
  if (memberIds.length === 0) return null;

  // Auto: pick member with the largest parameter count (by paramSize string)
  function extractBillions(s: string | undefined): number {
    if (!s) return 0;
    const m = s.match(/(\d+(?:\.\d+)?)\s*[TtBb]/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return /[Tt]/.test(m[0]) ? n * 1000 : n; // trillions → billions
  }

  let best = memberIds[0];
  let bestB = -1;

  for (const id of memberIds) {
    const info = allModels.find(
      m => m.model === id.model && m.provider === id.provider,
    );
    const b = extractBillions(info?.paramSize);
    if (b > bestB) {
      bestB = b;
      best = id;
    }
  }

  return best;
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

export class CouncilOrchestrator {
  private registry: ProviderRegistry;
  private config: CouncilConfig;
  private runtime: RuntimeConfig;
  /** Cached model list for judge auto-selection */
  private modelCache: ModelInfo[] = [];

  constructor(
    registry: ProviderRegistry,
    config: CouncilConfig,
    runtime: RuntimeConfig,
  ) {
    this.registry = registry;
    this.config = config;
    this.runtime = runtime;
  }

  /** Update config in-place (used by configure_council tool) */
  updateConfig(partial: Partial<CouncilConfig>): void {
    Object.assign(this.config, partial);
  }

  getConfig(): CouncilConfig {
    return { ...this.config };
  }

  getRuntime(): RuntimeConfig {
    return { ...this.runtime };
  }

  /** List all reachable models across all providers */
  async listAllModels(): Promise<ModelInfo[]> {
    const results = await Promise.allSettled(
      this.registry.getAll().map(p => p.listModels()),
    );
    this.modelCache = results.flatMap(r =>
      r.status === 'fulfilled' ? r.value : [],
    );
    return this.modelCache;
  }

  /**
   * Zero-config council: every Ollama chat model currently available
   * (local + :cloud), minus embedding-only models.
   */
  async autoDiscoverCouncil(): Promise<ModelId[]> {
    if (this.modelCache.length === 0) {
      try {
        await this.listAllModels();
      } catch {
        return [];
      }
    }
    return this.modelCache
      .filter(m => m.provider === 'ollama' && !isEmbeddingModel(m))
      .map(m => ({ provider: 'ollama' as const, serverId: m.serverId, model: m.model }));
  }

  /** Ask the council and return a result in the configured (or overridden) mode */
  async ask(
    question: string,
    modeOverride?: ResponseMode,
    maxRoundsOverride?: number,
    verboseOverride?: boolean,
  ): Promise<CouncilResult> {
    const mode = modeOverride ?? this.config.responseMode;
    const maxRounds = maxRoundsOverride ?? this.config.maxDeconflictRounds;
    const verbose = verboseOverride ?? this.runtime.verbose;

    // ── Determine council membership ──────────────────────────────────────
    // If explicitly configured, use those. Otherwise (zero-config) auto-
    // discover all Ollama chat models — local and :cloud — as the council.
    let memberIds: ModelId[] = this.config.members.map(m => m.modelId);
    let autoUsed = false;
    if (memberIds.length === 0 && this.config.autoCouncil) {
      memberIds = await this.autoDiscoverCouncil();
      autoUsed = memberIds.length > 0;
    }

    // ── Resolve providers for each council member ─────────────────────────
    const members = memberIds.flatMap(id => {
      const provider = this.registry.resolve(id);
      return provider ? [{ modelId: id, provider }] : [];
    });

    if (members.length === 0) {
      throw new Error(
        autoUsed || this.config.autoCouncil
          ? 'No Ollama chat models found to form a council. Pull a model (e.g. `ollama pull llama3`) or set council models via configure_council.'
          : 'Council has no reachable members. Use configure_council or set COUNCIL_MODELS.',
      );
    }

    // ── Query all members (bounded concurrency) ───────────────────────────
    const responses = await queryMembers(question, members, this.runtime);

    // ── Individual mode — done ─────────────────────────────────────────────
    if (mode === 'individual') {
      return { mode: 'individual', question, responses } satisfies IndividualResult;
    }

    // ── Find the judge ─────────────────────────────────────────────────────
    // Warm the model cache so auto-selection can read parameter sizes.
    // Without this, a fresh session silently falls back to the first member
    // instead of picking the largest.
    if (!this.config.judgeModelId && this.modelCache.length === 0) {
      try {
        await this.listAllModels();
      } catch {
        /* best-effort — selectJudge will fall back to first member */
      }
    }
    const judgeModelId = selectJudge(
      this.config.judgeModelId,
      members.map(m => m.modelId),
      this.modelCache,
    );
    if (!judgeModelId) {
      throw new Error('No judge model available. Add models to council first.');
    }
    const judgeProvider = this.registry.resolve(judgeModelId);
    if (!judgeProvider) {
      throw new Error(
        `Judge model provider not found for ${modelIdLabel(judgeModelId)}`,
      );
    }

    const cc = { maxTokens: this.runtime.maxTokens, retries: this.runtime.retries };

    // ── Pooled (Delphi) ────────────────────────────────────────────────────
    // Neutral, attribution-free reconsideration. Skips categorization entirely.
    if (mode === 'pooled') {
      return runPooled({
        question,
        initialResponses: responses,
        members,
        judgeModelId,
        judgeProvider,
        runtime: this.runtime,
        verbose,
      });
    }

    // ── Dialectic (thesis → antithesis → synthesis) ─────────────────────────
    // Members defend their pick, judge builds pros/cons, members re-select.
    if (mode === 'dialectic') {
      return runDialectic({
        question,
        initialResponses: responses,
        members,
        judgeModelId,
        judgeProvider,
        runtime: this.runtime,
        verbose,
      });
    }

    // ── Categorize ────────────────────────────────────────────────────────
    const catResult = await categorize(
      question,
      responses,
      judgeModelId,
      judgeProvider,
      cc,
    );

    if (mode === 'categorized') {
      return {
        mode: 'categorized',
        ...catResult,
        rawResponses: responses,
      } satisfies CategorizedResult;
    }

    // ── Deconflicted ──────────────────────────────────────────────────────
    return deconflict({
      question,
      initialResponses: responses,
      initialConflicts: catResult.conflicting,
      commonAgreement: catResult.commonAgreement,
      complementary: catResult.complementary,
      maxRounds,
      members,
      judgeModelId,
      judgeProvider,
      runtime: this.runtime,
      verbose,
    }) as Promise<DeconflictedResult>;
  }
}
