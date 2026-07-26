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
import { checkVisionPooled, Member, ProgressReporter, queryMembers } from './query.js';
import { loadState, saveState, VisionCacheEntry, VISION_CACHE_TTL_MS } from '../state.js';

// ─── Model classification ──────────────────────────────────────────────────────

/** Embedding-only models can't participate in a chat council. */
export function isEmbeddingModel(m: ModelInfo): boolean {
  if (m.family && /^(bert|nomic-bert)$/i.test(m.family)) return true;
  return /(^|[-_/])(embed|embedding|bge|nomic-embed|gte|e5|arctic-embed|mxbai-embed)([-_:/]|$)/i.test(
    m.model,
  );
}

// ─── Judge selection ──────────────────────────────────────────────────────────

export function selectJudge(
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
    // Also match serverId — without it, a multi-server setup (e.g.
    // "vllm/gpu1:llama3:70b" alongside "vllm/gpu2:llama3:7b") can look up the
    // WRONG server's entry (or none, since allModels may not even list every
    // server's models together), silently defaulting bestB to 0 for every
    // candidate and picking candidates[0] instead of the actual largest.
    const info = allModels.find(
      m => m.model === id.model && m.provider === id.provider && m.serverId === id.serverId,
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
    onProgress?: ProgressReporter,
    fullRepoAccessRepo?: string,
  ): Promise<CouncilResult> {
    const mode = modeOverride ?? this.config.responseMode;
    const maxRounds = maxRoundsOverride ?? this.config.maxDeconflictRounds;
    const verbose = verboseOverride ?? this.runtime.verbose;
    // A shallow per-call clone — never mutate the shared this.runtime, or a
    // concurrent ask_council call without full_repo_access would see it too.
    const runtime: RuntimeConfig = fullRepoAccessRepo
      ? { ...this.runtime, fullRepoAccess: fullRepoAccessRepo }
      : this.runtime;

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
      // Seed each member's provider from any previously-verified result on
      // disk, so a restart doesn't re-pay the OCR-challenge round trip for a
      // model already proven (in)capable in a prior session — on a slow
      // machine that adds up across a multi-member council. A seed is only
      // trusted within VISION_CACHE_TTL_MS of when it was actually verified
      // — an expired entry is left unseeded so checkVisionPooled below
      // genuinely re-probes it, rather than a stale "not capable" result
      // (from before a later Ollama pull or provider fix) sticking forever.
      const persistedVision = loadState().visionCapability ?? {};
      const visionCheckedAt = Date.now();
      const seededLabels = new Set<string>();
      for (const m of members) {
        const label = modelIdLabel(m.modelId);
        const entry = persistedVision[label];
        if (entry && visionCheckedAt - entry.checkedAt < VISION_CACHE_TTL_MS) {
          m.provider.seedVisionCache({ [m.modelId.model]: entry.value });
          seededLabels.add(label);
        }
      }

      const checked = await checkVisionPooled(members, runtime, onProgress);
      const visionMembers = checked.filter(c => c.vision).map(c => c.member);
      const skippedNonVision = checked.filter(c => !c.vision).map(c => modelIdLabel(c.member.modelId));

      // Persist any freshly-verified DEFINITIVE results — getVisionCache()
      // only ever contains definitive entries, since a transient/inconclusive
      // probe is never cached in-memory in the first place — so future
      // restarts skip re-probing them too.
      //
      // "Freshly-verified" means genuinely re-probed THIS call — every label
      // NOT in `seededLabels` (no cache seed, or its seed had expired), since
      // that's exactly the set checkVisionPooled had to actually probe live.
      // Persisting unconditionally for that set (not just when the value
      // CHANGED) is what refreshes `checkedAt` on an expired-but-unchanged
      // result — without this, an expired entry whose re-probe comes back
      // the same would never reset its own clock and would re-probe on
      // every single subsequent call forever, defeating the TTL's purpose.
      //
      // Collect only what THIS call newly learned (relative to the pre-probe
      // snapshot above), and merge it via saveState's mutator form — which
      // reads state fresh at write time — rather than writing a full object
      // built from that now-possibly-stale snapshot. Two concurrent image
      // asks each computing a full replacement object from an early read
      // would otherwise have whichever saveState() call lands second
      // silently discard the other's newly-learned entries (same-key,
      // shallow-merge collision, not a torn write — see saveState's comment).
      const newlyConfirmed: Record<string, VisionCacheEntry> = {};
      for (const m of members) {
        const label = modelIdLabel(m.modelId);
        if (seededLabels.has(label)) continue; // still within TTL, not re-probed this call
        const cache = m.provider.getVisionCache();
        const value = cache[m.modelId.model];
        if (value !== undefined) {
          newlyConfirmed[label] = { value, checkedAt: visionCheckedAt };
        }
      }
      if (Object.keys(newlyConfirmed).length > 0) {
        saveState(current => ({
          visionCapability: { ...(current.visionCapability ?? {}), ...newlyConfirmed },
        }));
      }

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
    const responses = await queryMembers(question, queryTargets, runtime, {}, images, onProgress);

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

    const cc = {
      maxTokens: this.runtime.maxTokens,
      retries: this.runtime.retries,
      timeoutMs: this.runtime.requestTimeoutMs,
    };

    // The judge is itself a council member; a genuine judge failure (unreachable,
    // rate-limited, quota-exhausted, or — moved inside this block precisely so
    // it's covered too — simply unresolvable, e.g. a configured judge_model
    // whose provider has no API key) should NOT discard every member's
    // already-collected answer. Degrade to individual mode with a note
    // instead of aborting. Resolving judgeProvider used to happen BEFORE this
    // try block, so that specific failure threw away the entire member
    // fan-out's responses (and the real compute/quota already spent
    // collecting them) instead of degrading like every other judge failure.
    try {
      const judgeProvider = this.registry.resolve(judgeModelId);
      if (!judgeProvider) {
        throw new Error(
          `Judge model provider not found for ${modelIdLabel(judgeModelId)}`,
        );
      }
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
          runtime,
          verbose,
          images,
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
          runtime,
          verbose,
          images,
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
        runtime,
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
        runtime,
        verbose,
        judgeDegraded: catResult.judgeDegraded,
        images,
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
