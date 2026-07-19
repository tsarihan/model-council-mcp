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
  VisionRouting,
} from '../types.js';
import { ChatImage } from '../providers/base.js';
import { ProviderRegistry } from '../providers/registry.js';
import { modelIdLabel } from '../config.js';
import { categorize } from './categorizer.js';
import { deconflict } from './deconflict.js';
import { runDialectic } from './dialectic.js';
import { runPooled } from './pool.js';
import { Member, queryMembers } from './query.js';

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
  erroredLabels: Set<string> = new Set(),
): ModelId | null {
  if (judgeModelId) return judgeModelId;
  if (memberIds.length === 0) return null;

  // Prefer members that answered successfully in round 0 — picking a member that
  // just failed would very likely fail the judge call too (and abort the ask).
  // Only fall back to the full list if every member errored.
  const healthy = memberIds.filter(id => !erroredLabels.has(modelIdLabel(id)));
  const candidates = healthy.length > 0 ? healthy : memberIds;

  // Auto: pick candidate with the largest parameter count (by paramSize string)
  function extractBillions(s: string | undefined): number {
    if (!s) return 0;
    const m = s.match(/(\d+(?:\.\d+)?)\s*[TtBb]/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return /[Tt]/.test(m[0]) ? n * 1000 : n; // trillions → billions
  }

  let best = candidates[0];
  let bestB = -1;

  for (const id of candidates) {
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
    images?: ChatImage[],
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
    // Members whose provider isn't registered (typo'd name, or a cloud provider
    // with no API key) are dropped — collect them so the drop isn't silent.
    const members: Member[] = [];
    const dropped: string[] = [];
    for (const id of memberIds) {
      const provider = this.registry.resolve(id);
      if (provider) members.push({ modelId: id, provider });
      else dropped.push(modelIdLabel(id));
    }
    if (dropped.length > 0) {
      process.stderr.write(
        `[model-council] ${dropped.length} configured member(s) have no available ` +
        `provider and were skipped: ${dropped.join(', ')}\n`,
      );
    }

    if (members.length === 0) {
      if (dropped.length > 0) {
        // Distinct from the "no Ollama models" case: the user DID configure
        // members, they just don't resolve — say so instead of misdiagnosing.
        throw new Error(
          `Council members are configured but none resolve to an available provider: ` +
          `${dropped.join(', ')}. Check the provider names / API keys, or reconfigure ` +
          `with configure_council.`,
        );
      }
      throw new Error(
        autoUsed || this.config.autoCouncil
          ? 'No Ollama chat models found to form a council. Pull a model (e.g. `ollama pull llama3`) or set council models via configure_council.'
          : 'Council has no reachable members. Use configure_council or set COUNCIL_MODELS.',
      );
    }

    // ── Vision routing ──────────────────────────────────────────────────────
    // Images are the trigger, not NLP classification of the question — if any
    // are attached, probe each resolved member's provider (cached after the
    // first call) and query ONLY the confirmed vision-capable subset. This is
    // what guarantees an image never reaches a non-vision model: the filter
    // runs before the fan-out, not as a per-provider best-effort.
    let queryTargets = members;
    let visionRouting: VisionRouting | undefined;
    if (images && images.length > 0) {
      const checked = await Promise.all(
        members.map(async m => ({
          member: m,
          vision: await m.provider.supportsVision(m.modelId.model).catch(() => false),
        })),
      );
      const visionMembers = checked.filter(c => c.vision).map(c => c.member);
      const skippedNonVision = checked.filter(c => !c.vision).map(c => modelIdLabel(c.member.modelId));
      if (visionMembers.length === 0) {
        throw new Error(
          `${images.length} image(s) attached, but none of the ${members.length} configured council ` +
          `member(s) are vision-capable: ${members.map(m => modelIdLabel(m.modelId)).join(', ')}. ` +
          `Add a vision-capable model with configure_council, or ask without images.`,
        );
      }
      queryTargets = visionMembers;
      visionRouting = {
        imagesAttached: images.length,
        queriedVisionModels: visionMembers.map(m => modelIdLabel(m.modelId)),
        skippedNonVision,
      };
    }

    // ── Query all members (bounded concurrency) ───────────────────────────
    const responses = await queryMembers(question, queryTargets, this.runtime, {}, images);

    // ── Individual mode — done ─────────────────────────────────────────────
    if (mode === 'individual') {
      return {
        mode: 'individual',
        question,
        responses,
        ...(visionRouting ? { visionRouting } : {}),
      } satisfies IndividualResult;
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
    const erroredLabels = new Set(responses.filter(r => r.error).map(r => r.label));
    const judgeModelId = selectJudge(
      this.config.judgeModelId,
      // queryTargets, not members: candidates must actually have a response
      // (when images filtered the council to a vision-capable subset, the
      // skipped members never ran and would otherwise be eligible for judge).
      queryTargets.map(m => m.modelId),
      this.modelCache,
      erroredLabels,
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

    const cc = {
      maxTokens: this.runtime.maxTokens,
      retries: this.runtime.retries,
      timeoutMs: this.runtime.requestTimeoutMs,
    };

    // The judge is itself a council member; a genuine judge failure (unreachable,
    // rate-limited, quota-exhausted) should NOT discard every member's already-
    // collected answer. Degrade to individual mode with a note instead of aborting.
    try {
      // ── Pooled (Delphi) ──────────────────────────────────────────────────
      // Neutral, attribution-free reconsideration. Skips categorization entirely.
      if (mode === 'pooled') {
        const pooled = await runPooled({
          question,
          initialResponses: responses,
          // queryTargets: reconsideration re-questions the same members that
          // answered round 0 — a vision-skipped member never saw the question.
          members: queryTargets,
          judgeModelId,
          judgeProvider,
          runtime: this.runtime,
          verbose,
        });
        return visionRouting ? { ...pooled, visionRouting } : pooled;
      }

      // ── Dialectic (thesis → antithesis → synthesis) ───────────────────────
      // Members defend their pick, judge builds pros/cons, members re-select.
      if (mode === 'dialectic') {
        const dialectic = await runDialectic({
          question,
          initialResponses: responses,
          members: queryTargets,
          judgeModelId,
          judgeProvider,
          runtime: this.runtime,
          verbose,
        });
        return visionRouting ? { ...dialectic, visionRouting } : dialectic;
      }

      // ── Categorize ──────────────────────────────────────────────────────
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
          ...(visionRouting ? { visionRouting } : {}),
        } satisfies CategorizedResult;
      }

      // ── Deconflicted ────────────────────────────────────────────────────
      const dec = (await deconflict({
        question,
        initialResponses: responses,
        initialConflicts: catResult.conflicting,
        commonAgreement: catResult.commonAgreement,
        complementary: catResult.complementary,
        maxRounds,
        members: queryTargets,
        judgeModelId,
        judgeProvider,
        runtime: this.runtime,
        verbose,
      })) as DeconflictedResult;
      return visionRouting ? { ...dec, visionRouting } : dec;
    } catch (err) {
      // Degrade to individual so member work isn't discarded — but log the full
      // error to stderr so a genuine bug (not just a judge outage) stays visible
      // rather than being silently masked as a "successful" fallback.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[model-council] ${mode} reconciliation failed; returning individual responses: ` +
        `${err instanceof Error ? err.stack ?? msg : msg}\n`,
      );
      return {
        mode: 'individual',
        question,
        responses,
        note:
          `Reconciliation (${mode} mode, judge ${modelIdLabel(judgeModelId)}) failed — ${msg}. ` +
          `Returning the council's raw individual responses.`,
        ...(visionRouting ? { visionRouting } : {}),
      } satisfies IndividualResult;
    }
  }
}
