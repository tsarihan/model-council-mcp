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
  ProviderType,
  RawResponse,
  ReasoningEffort,
  ResponseMode,
  RuntimeConfig,
  UsageReport,
  VisionRouting,
  WebRouting,
} from '../types.js';
import { ChatImage } from '../providers/base.js';
import { ProviderRegistry } from '../providers/registry.js';
import { modelIdLabel } from '../config.js';
import { categorize } from './categorizer.js';
import { deconflict } from './deconflict.js';
import { runDialectic } from './dialectic.js';
import { runPooled } from './pool.js';
import { checkVisionPooled, Member, ProgressReporter, queryMembers, withPhase } from './query.js';
import { loadState, saveState, VisionCacheEntry, VISION_CACHE_TTL_MS } from '../state.js';
import { HarnessKind, harnessLadder, toolDialectRisk } from '../harness.js';
import { learnedTimeoutFloorMs, probeHarness, rememberRoundSuccess, rememberedHarness, routedId } from '../probe.js';
import { collectSources } from './sources.js';

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
    // Prefer exact match; fall back to model-name-only for harness-remapped
    // members (autoPopulatedMembers routes Ollama cloud models through
    // claude-cli/claude-cli-ollama, but modelCache has provider:'ollama').
    // Scoped to the harness case to preserve the multi-server guard above.
    const info = allModels.find(
      m => m.model === id.model && m.provider === id.provider && m.serverId === id.serverId,
    ) ?? (id.provider === 'claude-cli' && id.serverId === 'claude-cli-ollama'
      ? allModels.find(m => m.model === id.model) : undefined);
    const b = extractBillions(info?.paramSize);
    if (b > bestB) {
      bestB = b;
      best = id;
    }
  }

  return best;
}

const TIMEOUT_LABEL_RE = /\btimed out\b|\btimeout\b/i;

/**
 * Attach `timedOutMembers` to a council result from every RawResponse[] the
 * orchestrator has in hand — the initial fan-out (`initialResponses`, always
 * available regardless of verbose) plus any response arrays the mode result
 * itself carries (rawResponses/reconsidered/defenses/selections/initialResponses,
 * and the verbose `rounds[].responses`), merged with any `timedOutMembers` a
 * mode function already attached from its own round responses (deconflict does
 * this, so a round-2+ timeout surfaces even under verbose:false where `rounds`
 * is omitted). This keeps timeout detection working under `verbose: false`,
 * where the per-round responses that carry the error are otherwise dropped.
 */
function attachTimedOut<T extends object>(result: T, initialResponses: RawResponse[]): T {
  const labels = new Set<string>();
  // Per-member spend, gathered from the SAME arrays the timeout scan walks —
  // one walk answers both "who was cut off" and "what did this ask cost".
  const spend = new Map<string, { calls: number; totalMs: number }>();
  const walked: RawResponse[][] = [];
  const collect = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    walked.push(arr as RawResponse[]);
    for (const r of arr) {
      if (r && typeof r === 'object' && typeof (r as { label?: unknown }).label === 'string') {
        const rr = r as { label: string; error?: unknown; latencyMs?: unknown };
        if (rr.error && TIMEOUT_LABEL_RE.test(String(rr.error))) labels.add(rr.label);
        const ms = typeof rr.latencyMs === 'number' && Number.isFinite(rr.latencyMs) ? rr.latencyMs : 0;
        const e = spend.get(rr.label) ?? { calls: 0, totalMs: 0 };
        e.calls += 1; e.totalMs += ms;
        spend.set(rr.label, e);
      }
    }
  };
  collect(initialResponses);
  const r = result as Record<string, unknown>;
  // `initialResponses` on the result is the SAME array already collected above
  // (verbose mode re-attaches it) — walking it again would double every
  // member's spend, so it is deliberately absent from this list.
  collect(r.responses !== (initialResponses as unknown) ? r.responses : undefined);
  collect(r.rawResponses !== (initialResponses as unknown) ? r.rawResponses : undefined);
  collect(r.reconsidered);
  collect(r.defenses);
  collect(r.selections);
  if (Array.isArray(r.rounds)) for (const rd of r.rounds) if (rd && typeof rd === 'object') collect((rd as Record<string, unknown>).responses);
  // Merge labels a mode function attached itself (e.g. deconflict from rounds).
  const existing = (result as { timedOutMembers?: unknown }).timedOutMembers;
  if (Array.isArray(existing)) for (const l of existing) if (typeof l === 'string') labels.add(l);

  const byMember = [...spend.entries()]
    .map(([label, v]) => ({ label, calls: v.calls, totalMs: v.totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const usage: UsageReport = {
    completions: byMember.reduce((n, m) => n + m.calls, 0),
    totalLatencyMs: byMember.reduce((n, m) => n + m.totalMs, 0),
    byMember,
  };

  // Judge independence: a judge that is ALSO a member reconciled its own
  // answer. Fine when configured deliberately, but the reader of
  // "commonAgreement" should know the referee played.
  const judgeModel = typeof r.judgeModel === 'string' ? r.judgeModel : undefined;
  const judgeIsMember = !!judgeModel && initialResponses.some(x => x.label === judgeModel);

  // Consolidated citations, only meaningful when members actually researched.
  const webRouting = r.webRouting as WebRouting | undefined;
  const sources = webRouting ? collectSources(walked) : undefined;

  return {
    ...result,
    ...(labels.size ? { timedOutMembers: [...labels] } : {}),
    usage,
    ...(judgeIsMember ? { judgeIsMember: true } : {}),
    ...(webRouting && sources?.length ? { webRouting: { ...webRouting, sources } } : {}),
  } as T;
}

/**
 * Can this provider type actually run a live search? Only the CLI-backed
 * providers have an agentic tool loop to grant a search tool inside; every
 * other provider gets one flattened completion with no tool turn, so granting
 * it web access would be a no-op the caller could not see.
 */
function canResearch(type: ProviderType): boolean {
  return type === 'claude-cli' || type === 'codex-cli' || type === 'grok-cli';
}

/**
 * Re-point a member through whichever harness can actually drive its engine, so
 * a member that could work is never left unable to just because its own
 * provider has no tool loop.
 *
 * Driven by the shipped matrix (harness.ts): claude-cli first for anything that
 * speaks — or might speak — the Anthropic Messages API, codex-cli's custom
 * provider for engines that provably cannot. The whole ladder is tried in
 * order, so an unregistered first choice falls through instead of giving up,
 * and an id is returned unchanged only when NOTHING can drive it — which
 * degrades to "answers from memory, and says so", never to a dropped member.
 *
 * Per-call, not persisted: nothing about the configured council changes, only
 * how it is reached for THIS ask.
 */
function harnessRoute(id: ModelId, registry: ProviderRegistry): ModelId {
  // Already on a harness-capable provider — nothing to re-point.
  if (id.provider === 'claude-cli' || id.provider === 'codex-cli' || id.provider === 'grok-cli') return id;

  // LEARNED knowledge wins over the seeded ladder: a probe measured this
  // machine, the matrix only describes engines in general. A remembered
  // 'none' is respected too — re-trying a route already proven dead just
  // spends latency to reach the same flattened completion.
  const learned = rememberedHarness(id);
  if (learned) {
    if (learned.harness === 'none') return id;
    const routed = routedId(id, learned.harness, registry);
    if (routed) return routed;
  }

  for (const kind of harnessLadder(id.provider)) {
    const routed = routedId(id, kind, registry);
    if (routed) return routed;
  }
  return id;
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

  /** Update runtime in-place (used by set_council_timeouts to apply a runtime
   *  change without a reload). Shallow-merges so a caller can override just the
   *  timeout fields without touching concurrency/poolLimits. */
  updateRuntime(partial: Partial<RuntimeConfig>): void {
    this.runtime = { ...this.runtime, ...partial };
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
   * (local + :cloud), minus embedding-only models. This is the fallback when
   * no council is configured — cloud models stay on bare Ollama here because
   * auto-discovered models may not work through the CLI harness (the boot-path
   * `autoPopulatedMembers()` in detect.ts routes curated cloud models through
   * the harness instead).
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
    originalQuestion?: string,
    effortOverride?: ReasoningEffort,
    webAccessOverride?: boolean,
    memberEffortsRaw?: Record<string, ReasoningEffort>,
  ): Promise<CouncilResult> {
    // `question` is what MEMBERS see — possibly augmented by buildAugmentedQuestion
    // with untrusted context/files/git-diff content. `judgeQuestion` is the
    // ORIGINAL, pre-augmentation question used for every JUDGE prompt: the judge
    // classifies member response text and must not receive the raw attachments,
    // which would otherwise sit in a trust-affirming "question" block above the
    // untrusted-content notice — a prompt-injection path into the judge. Falls
    // back to `question` when a caller doesn't distinguish them (e.g. tests).
    const judgeQuestion = originalQuestion ?? question;
    const mode = modeOverride ?? this.config.responseMode;
    const maxRounds = maxRoundsOverride ?? this.config.maxDeconflictRounds;
    const verbose = verboseOverride ?? this.runtime.verbose;
    // Snapshot the judge preference at the START of the call, alongside the
    // member snapshot below — selectJudge reads it AFTER the member fan-out
    // await, so reading this.config.judgeModelId there would race a concurrent
    // configure_council that swapped the judge mid-call (members from config
    // A, judged by config B). The local is immune to that.
    const judgeModelIdPref = this.config.judgeModelId;
    // A shallow per-call clone — never mutate the shared this.runtime, or a
    // concurrent ask_council call without full_repo_access would see it too.
    // When repo access is granted, also swap in the longer repo per-completion
    // timeout — repo-reading completions (CLI member Read/Grep/Glob over the
    // tree) materially outlast a flat text completion.
    // A per-call reasoning_effort rides on the same clone, for the same reason:
    // it must not leak into a concurrent ask_council that didn't ask for it.
    // full_repo_access AND web access both make a member consume far more
    // content than a plain question does — a repo tree, or several fetched
    // pages — and output length scales with it. They get the same longer
    // per-completion budget for the same reason; web access previously kept
    // the SHORT text budget, which is the wrong end of a 20x throughput
    // spread for exactly the calls most likely to run long.
    const heavy = !!fullRepoAccessRepo || !!(webAccessOverride ?? this.runtime.webAccess);
    const baseRuntime: RuntimeConfig = fullRepoAccessRepo || heavy
      ? {
          ...this.runtime,
          ...(fullRepoAccessRepo ? { fullRepoAccess: fullRepoAccessRepo } : {}),
          requestTimeoutMs: Math.max(this.runtime.requestTimeoutMs, this.runtime.repoRequestTimeoutMs),
        }
      : this.runtime;
    const runtime: RuntimeConfig = {
      ...baseRuntime,
      ...(effortOverride ? { reasoningEffort: effortOverride } : {}),
      // Explicit `false` must be able to turn OFF a configured default, so
      // this tests for undefined rather than truthiness.
      ...(webAccessOverride !== undefined ? { webAccess: webAccessOverride } : {}),
    };

    // ── Determine council membership ──────────────────────────────────────
    // If explicitly configured, use those. Otherwise (zero-config) auto-
    // discover all Ollama chat models — local and :cloud — as the council.
    let memberIds: ModelId[] = this.config.members.map(m => m.modelId);
    let autoUsed = false;
    if (memberIds.length === 0 && this.config.autoCouncil) {
      memberIds = await this.autoDiscoverCouncil();
      autoUsed = memberIds.length > 0;
    }

    // ── Web access: re-point what can be re-pointed ───────────────────────
    // Done BEFORE provider resolution so the rest of the call sees the routed
    // member as its real identity (pool key, label, judge candidacy).
    const routedViaHarness: string[] = [];
    const probeNotes: { label: string; risk: string; definite: boolean }[] = [];
    const routedFrom = new Map<string, ModelId>();
    if (runtime.webAccess) {
      // Probe anything we have no fresh measurement for, ONCE, before routing.
      // A member we know nothing about gets tried rather than written off —
      // and the result is persisted, so this is paid at most once per model per
      // TTL, across restarts and plugin updates. Only unknown members probe, so
      // a steady-state council pays nothing.
      for (const id of memberIds) {
        if (id.provider === 'claude-cli' || id.provider === 'codex-cli' || id.provider === 'grok-cli') continue;
        if (rememberedHarness(id)) continue;
        try {
          const cap = await probeHarness(id, this.registry, {
            wantTools: true,
            // The SAME budget a real round gets. A probe held to a tighter
            // deadline than the work it imitates can only produce a false
            // negative on a slow model — one cloud model took 400s live.
            toolTimeoutMs: runtime.requestTimeoutMs,
          });
          await onProgress?.(`Detected ${modelIdLabel(id)}: harness ${cap.harness}, tools ${cap.tools}`);
          // A harness that drives chat but cannot execute tool calls is still
          // used — it just must not be reported as having researched.
          if (cap.tools !== 'ok' && cap.harness !== 'none') {
            // Keyed by the ROUTED label, because that is the identity the
            // member carries by the time the report is built — keying it by
            // the pre-route id silently dropped every warning (measured).
            const r = harnessRoute(id, this.registry);
            probeNotes.push({
              label: modelIdLabel(r),
              risk: cap.note ?? `tool calling is ${cap.tools} on this model, so it may answer from memory`,
              // 'untested' is inconclusive (e.g. a timed-out probe), so it
              // warns without claiming the member definitely cannot research.
              definite: cap.tools === 'leaks' || cap.tools === 'unsupported',
            });
          }
        } catch {
          /* detection is best-effort — a failed probe must not fail the ask */
        }
      }

      memberIds = memberIds.map(id => {
        const routed = harnessRoute(id, this.registry);
        if (routed !== id) {
          routedViaHarness.push(`${modelIdLabel(id)} → ${modelIdLabel(routed)}`);
          // Keep the pre-route identity: the capability memory is keyed by it
          // (that is what rememberedHarness() looks up), so learning from this
          // round's outcome has to map back from the routed label.
          routedFrom.set(modelIdLabel(routed), id);
        }
        return routed;
      });
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

    // ── Per-member effort pins (tier 3 of the effort hierarchy) ───────────
    // Keys are matched FORGIVINGLY (exact label, exact model part, or a
    // unique substring — nobody should have to type
    // "claude-cli/claude-cli-ollama:glm-5.2:cloud" to pin glm) but failures
    // are LOUD: an unknown or ambiguous key throws with the valid labels,
    // because a silently-dropped pin would run the one member the caller
    // specifically tried to slow down at full depth — invisible, and costly.
    if (memberEffortsRaw && Object.keys(memberEffortsRaw).length) {
      const candidates = [...members.map(m => modelIdLabel(m.modelId))];
      if (judgeModelIdPref) {
        const jl = modelIdLabel(judgeModelIdPref);
        if (!candidates.includes(jl)) candidates.push(jl); // a pinned non-member judge is pinnable too
      }
      const resolved: Record<string, ReasoningEffort> = {};
      for (const [key, effort] of Object.entries(memberEffortsRaw)) {
        const exact = candidates.filter(c => c === key);
        const byModel = exact.length ? exact : candidates.filter(c => c.split(':').slice(1).join(':') === key || c.endsWith(`:${key}`));
        const bySubstr = byModel.length ? byModel : (key.length >= 3 ? candidates.filter(c => c.includes(key)) : []);
        if (bySubstr.length === 0) {
          throw new Error(
            `member_efforts: "${key}" matches no council member or judge. Valid labels: ${candidates.join(', ')}`,
          );
        }
        if (bySubstr.length > 1) {
          throw new Error(
            `member_efforts: "${key}" is ambiguous — it matches ${bySubstr.join(' AND ')}. Use a longer/full label.`,
          );
        }
        resolved[bySubstr[0]] = effort;
      }
      runtime.memberEffort = resolved;
    }

    // ── Per-member timeout floors ─────────────────────────────────────────
    // Members differ in throughput by roughly 20x on this hardware (a local
    // model ~10 tok/s, Ollama cloud ~200, hosted APIs 20-50), so one deadline
    // cannot fit them all. A member that has genuinely needed longer before is
    // given at least that again — learned, not configured.
    {
      const floors: Record<string, number> = {};
      for (const m of members) {
        const floor = learnedTimeoutFloorMs(m.modelId, heavy);
        if (floor && floor > runtime.requestTimeoutMs) floors[modelIdLabel(m.modelId)] = floor;
      }
      if (Object.keys(floors).length) runtime.memberTimeoutMs = floors;
    }

    // ── Web routing report ────────────────────────────────────────────────
    // Built even when every member can research, so "the council researched"
    // is something the caller can verify rather than infer.
    let webRouting: WebRouting | undefined;
    if (runtime.webAccess) {
      webRouting = {
        researched: [],
        fromMemory: [],
        ...(routedViaHarness.length ? { routedViaHarness } : {}),
      };
      for (const m of members) {
        const label = modelIdLabel(m.modelId);
        const proven = probeNotes.find(n => n.label === label);
        if (proven?.definite) {
          // Measured as unable to execute a tool call. Reporting it as
          // "researched" would be the exact false assurance webRouting exists
          // to prevent — it is answering from training data like any member
          // with no tool loop at all.
          webRouting.fromMemory.push({ label, reason: proven.risk });
        } else if (canResearch(m.provider.config.type)) {
          webRouting.researched.push(label);
          // A model can be granted the tool and still be unable to use it —
          // its tool-call dialect may not be one the harness can execute.
          // Surface the known risk rather than letting "researched" imply a
          // search definitely ran (claude-cli.ts refuses the leaked-markup
          // reply, so the member errors visibly, but the warning is cheaper).
          // A MEASURED result outranks the shipped hint — it named this
          // machine's actual behaviour, not a general caveat about the family.
          const measured = proven?.risk;
          // A model MEASURED as tool-capable — by a probe or by a prior
          // successful researched round — must not keep wearing its family's
          // seeded caveat. The hint exists to warn about the unknown; once the
          // answer is known, repeating it every run just teaches the caller
          // to ignore warnings.
          const learned = rememberedHarness(routedFrom.get(label) ?? m.modelId);
          const risk = measured ?? (learned?.tools === 'ok' ? undefined : toolDialectRisk(m.modelId.model));
          if (risk) {
            webRouting.toolDialectWarnings = webRouting.toolDialectWarnings ?? [];
            webRouting.toolDialectWarnings.push({ label, risk });
          }
        }
        else {
          webRouting.fromMemory.push({
            label,
            reason: `${m.provider.config.type} returns a single completion with no tool loop, so it cannot run a search`,
          });
        }
      }
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
      // KNOWN, DEFERRED (round 7): this block's bookkeeping (seededLabels /
      // alreadyCachedLabels below) is keyed by modelIdLabel (includes
      // serverId), while each provider's own in-memory visionVerifiedCache is
      // keyed by bare model name. Two council members that resolve to the
      // SAME provider instance + bare model under DIFFERENT labels (e.g.
      // "ollama:llama3" vs "ollama/ollama:llama3" — both resolve to the same
      // provider, since "ollama" is that server's own registered id) can
      // still launder a seeded-but-never-live-probed value into a fresh
      // on-disk lease for the alias label, the same laundering class round 5
      // fixed for the ordinary case. Low severity — requires a deliberately
      // aliased member list — and a proper fix needs the bookkeeping keyed by
      // resolved (provider, model) identity instead of label, consistently
      // across every provider's getVisionCache()/seedVisionCache() AND
      // state.ts's label-keyed visionCapability schema; not done here to
      // avoid a narrowly-scoped fix reintroducing the same class of gap.
      //
      // Seed each member's provider from any previously-verified result on
      // disk, so a restart doesn't re-pay the OCR-challenge round trip for a
      // model already proven (in)capable in a prior session — on a slow
      // machine that adds up across a multi-member council. A seed is only
      // trusted when it passes ALL of:
      //  - shape: `value` a real boolean, `checkedAt` a real number — state.json
      //    is server-owned but could be hand-edited/corrupted; loadState() only
      //    rejects a bare top-level array, nothing validates individual
      //    visionCapability entries. A truthy non-boolean `value` (e.g. the
      //    STRING "false") would otherwise flow straight into seedVisionCache
      //    and defeat the "an image never reaches a non-vision model"
      //    guarantee this routing exists for.
      //  - not future-dated: `checkedAt <= visionCheckedAt` — without this, a
      //    `checkedAt` ahead of the current clock (skewed system clock, a
      //    resumed VM, a hand-edited file) makes `visionCheckedAt -
      //    entry.checkedAt` negative, which satisfies `< VISION_CACHE_TTL_MS`
      //    forever — permanently defeating the TTL below for that entry.
      //  - within VISION_CACHE_TTL_MS of when it was actually verified — an
      //    expired entry is left unseeded so checkVisionPooled below genuinely
      //    re-probes it, rather than a stale "not capable" result (from before
      //    a later Ollama pull or provider fix) sticking forever.
      const persistedVision = loadState().visionCapability ?? {};
      const visionCheckedAt = Date.now();
      const seededLabels = new Set<string>();
      // A provider instance is long-lived (registered once at boot, reused
      // across every ask), so its in-memory visionVerifiedCache can already
      // hold a value from an EARLIER call in this same process — from a
      // prior seed, or a prior live probe — independent of whatever this
      // call's disk-freshness check decides. supportsVision() always
      // short-circuits on that in-memory cache with no I/O. Recording which
      // labels already have SOME in-memory value before this call's seeding
      // loop runs is what lets the persistence step below tell "genuinely
      // re-probed live this call" apart from "in-memory residue from before,
      // masquerading as fresh" — the two are otherwise indistinguishable from
      // seededLabels alone.
      const alreadyCachedLabels = new Set<string>();
      for (const m of members) {
        if (m.provider.getVisionCache()[m.modelId.model] !== undefined) {
          alreadyCachedLabels.add(modelIdLabel(m.modelId));
        }
      }
      const isFreshEntry = (entry: VisionCacheEntry | undefined): entry is VisionCacheEntry =>
        !!entry &&
        typeof entry.value === 'boolean' &&
        typeof entry.checkedAt === 'number' &&
        entry.checkedAt <= visionCheckedAt &&
        visionCheckedAt - entry.checkedAt < VISION_CACHE_TTL_MS;
      for (const m of members) {
        const label = modelIdLabel(m.modelId);
        const entry = persistedVision[label];
        if (isFreshEntry(entry)) {
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
      // "Freshly-verified" means genuinely re-probed LIVE this call — every
      // label NOT in `seededLabels` (no valid disk seed) AND NOT in
      // `alreadyCachedLabels` (no in-memory residue from before this call
      // either). Excluding only `seededLabels` (the pre-round-5 logic) was
      // insufficient: a disk entry can expire while the SAME process's
      // in-memory cache still holds the old value from an earlier call, in
      // which case checkVisionPooled's supportsVision() short-circuits on
      // that stale in-memory value with zero I/O — persisting THAT with a
      // fresh `checkedAt` would launder a never-actually-re-verified result
      // into a brand-new 30-day on-disk lease, indefinitely, defeating the
      // TTL's entire purpose (it would never again trigger a real re-probe
      // for the life of the process, and the laundered lease survives
      // restarts too).
      //
      // Persisting unconditionally for the genuinely-live-probed set (not
      // just when the value CHANGED) is what refreshes `checkedAt` on an
      // expired-but-unchanged result — without this, an expired entry whose
      // re-probe comes back the same would never reset its own clock and
      // would re-probe on every single subsequent call forever, defeating
      // the TTL's purpose from the other direction.
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
        if (seededLabels.has(label) || alreadyCachedLabels.has(label)) continue; // not genuinely re-probed live this call
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
    const responses = withPhase(
      await queryMembers(question, queryTargets, runtime, {}, images, onProgress),
      'thesis',
    );

    // A member that just answered has demonstrated exactly what a probe
    // measures — so record it for free rather than paying for a probe next
    // time. Under web access a successful answer also proves the tool loop
    // ran, which is the one thing a slow model can never prove within a probe
    // budget. Only successes are recorded: a round can fail for reasons
    // (quota, timeout, a bad prompt) that say nothing about capability.
    for (const r of responses) {
      if (r.error || !r.response?.trim()) continue;
      // Members configured DIRECTLY on a harness (claude-cli/codex-cli ids in
      // the council) were previously never learned from — routedFrom only
      // holds re-routed members — so a directly-configured glm/deepseek kept
      // its seeded "probe before trusting" warning forever, however many
      // rounds it had just researched flawlessly. Their own id is the memory
      // key; grok-cli is excluded only because it is not a HarnessKind.
      const original = routedFrom.get(r.label)
        ?? ((r.modelId.provider === 'claude-cli' || r.modelId.provider === 'codex-cli') ? r.modelId : undefined);
      if (!original) continue;
      rememberRoundSuccess(original, r.modelId.provider as HarnessKind, !!runtime.webAccess, r.latencyMs, heavy);
    }

    // ── Individual mode — done ─────────────────────────────────────────────
    if (mode === 'individual') {
      return attachTimedOut({
        mode: 'individual',
        question,
        responses,
        ...(visionRouting ? { visionRouting } : {}),
        ...(webRouting ? { webRouting } : {}),
      } satisfies IndividualResult, responses);
    }

    // ── Find the judge ─────────────────────────────────────────────────────
    // Warm the model cache so auto-selection can read parameter sizes.
    // Without this, a fresh session silently falls back to the first member
    // instead of picking the largest. Use the snapshot (judgeModelIdPref), not
    // a live this.config read — selectJudge below uses the snapshot, so the
    // guard must decide on the same value or a concurrent configure_council
    // could flip this.config.judgeModelId to explicit mid-call, skip the warm,
    // and leave selectJudge's auto path with an empty cache (→ candidates[0]).
    if (!judgeModelIdPref && this.modelCache.length === 0) {
      try {
        await this.listAllModels();
      } catch {
        /* best-effort — selectJudge will fall back to first member */
      }
    }
    const erroredLabels = new Set(responses.filter(r => r.error).map(r => r.label));
    const judgeModelId = selectJudge(
      judgeModelIdPref,
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
      maxTokens: runtime.maxTokens,
      retries: runtime.retries,
      timeoutMs: runtime.requestTimeoutMs,
      // Judge calls run at the member depth by default — one setting governs
      // the whole ask — but the judge is a model like any other, so a
      // per-member pin on ITS label wins, letting a slow judge be turned down
      // without touching the members (or vice versa).
      effort: runtime.memberEffort?.[modelIdLabel(judgeModelId)] ?? runtime.reasoningEffort,
      // A repo-access judge reads real files through the same CLI session
      // limits as any member, so the tool-concurrency override rides along.
      toolConcurrency: runtime.harnessToolConcurrency,
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
          judgeQuestion,
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
        return attachTimedOut({ ...pooled, ...(visionRouting ? { visionRouting } : {}), ...(webRouting ? { webRouting } : {}) }, responses);
      }

      // ── Dialectic (thesis → antithesis → synthesis) ───────────────────────
      // Members defend their pick, judge builds pros/cons, members re-select.
      if (mode === 'dialectic') {
        const dialectic = await runDialectic({
          question,
          judgeQuestion,
          initialResponses: responses,
          members: queryTargets,
          judgeModelId,
          judgeProvider,
          runtime,
          verbose,
          images,
        });
        return attachTimedOut({ ...dialectic, ...(visionRouting ? { visionRouting } : {}), ...(webRouting ? { webRouting } : {}) }, responses);
      }

      // ── Categorize ──────────────────────────────────────────────────────
      // Judge prompt → original question (not the attachment-bearing augmented one).
      const catResult = await categorize(
        judgeQuestion,
        responses,
        judgeModelId,
        judgeProvider,
        cc,
        runtime,
      );

      if (mode === 'categorized') {
        return attachTimedOut({
          mode: 'categorized',
          ...catResult,
          rawResponses: responses,
          ...(visionRouting ? { visionRouting } : {}),
          ...(webRouting ? { webRouting } : {}),
        ...(webRouting ? { webRouting } : {}),
        } satisfies CategorizedResult, responses);
      }

      // ── Deconflicted ────────────────────────────────────────────────────
      const dec = (await deconflict({
        question,
        judgeQuestion,
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
      return attachTimedOut({ ...dec, ...(visionRouting ? { visionRouting } : {}), ...(webRouting ? { webRouting } : {}) }, responses);
    } catch (err) {
      // Degrade to individual so member work isn't discarded — but log the full
      // error to stderr so a genuine bug (not just a judge outage) stays visible
      // rather than being silently masked as a "successful" fallback.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[model-council] ${mode} reconciliation failed; returning individual responses: ` +
        `${err instanceof Error ? err.stack ?? msg : msg}\n`,
      );
      return attachTimedOut({
        mode: 'individual',
        question,
        responses,
        note:
          `Reconciliation (${mode} mode, judge ${modelIdLabel(judgeModelId)}) failed — ${msg}. ` +
          `Returning the council's raw individual responses.`,
        ...(visionRouting ? { visionRouting } : {}),
        ...(webRouting ? { webRouting } : {}),
      } satisfies IndividualResult, responses);
    }
  }
}
