// ─── Provider & Server types ──────────────────────────────────────────────────

export type ProviderType =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'vllm'
  | 'trtllm'
  | 'sglang'
  | 'claude-cli'
  | 'codex-cli'
  | 'grok-cli';

export type ResponseMode =
  | 'individual'
  | 'categorized'
  | 'deconflicted'
  | 'pooled'
  | 'dialectic';

// The canonical reasoning-effort scale and its per-provider mapping live in
// providers/effort.ts (next to the verified backend tables they describe);
// re-exported here so `types.ts` stays the single import site for the shared
// vocabularies, alongside ResponseMode/ProviderType.
import type { ReasoningEffort } from './providers/effort.js';
export type { ReasoningEffort };

/** A reference to a specific model on a specific server */
export interface ModelId {
  provider: ProviderType;
  /** Named server id for multi-server setups (vllm-gpu1, trt-server-2, …) */
  serverId?: string;
  model: string;
}

/** Extended info returned by list_models */
export interface ModelInfo extends ModelId {
  label: string;        // human-friendly display name
  paramSize?: string;   // e.g. "7B", "70B"
  family?: string;      // e.g. "llama3", "mistral"
  diskBytes?: number;
  contextLength?: number;
}

// ─── Council configuration ────────────────────────────────────────────────────

export interface CouncilMember {
  modelId: ModelId;
}

export interface CouncilConfig {
  members: CouncilMember[];
  /**
   * Which model acts as judge for categorisation/deconfliction.
   * undefined → auto (pick first available member, or largest by paramSize).
   */
  judgeModelId?: ModelId;
  responseMode: ResponseMode;
  maxDeconflictRounds: number;
  /**
   * When members is empty, auto-populate the council from all discovered
   * Ollama chat models (local + :cloud), excluding embedding models.
   * Default true — gives a zero-config experience.
   */
  autoCouncil: boolean;
}

/**
 * Concurrency pool a member belongs to. Each pool has its own limit so one
 * subscription's ceiling (e.g. ChatGPT 6) never starves another (Ollama cloud
 * 3/10). `local` covers local Ollama + self-hosted vLLM/TRT-LLM/SGLang.
 */
export type PoolKey =
  | 'chatgpt'
  | 'claude'
  | 'grok'
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'ollama-cloud'
  | 'local';

/** The user's selected subscription tiers (validated against subscriptions.json). */
export interface SubscriptionTiers {
  chatgpt: string;
  claude: string;
  ollama: string;
  grok: string;
}

/**
 * Runtime tuning knobs, set via environment / plugin userConfig.
 */
export interface RuntimeConfig {
  /** Max output tokens requested per completion (default 32768), clamped per-model to fit context. */
  maxTokens: number;
  /**
   * How much reasoning to ask every member AND the judge for, on the canonical
   * `none`…`max` scale (providers/effort.ts). Undefined (the default) sends
   * nothing, leaving each model at its own default depth. Set by
   * REASONING_EFFORT, by configure_council (persisted), or per call by
   * ask_council — the per-call value is applied to a shallow clone of this
   * config, never to the shared server-wide one.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Grant council members live web search for this ask, so they research
   * rather than answer from training data. Off by default: it costs latency
   * and quota, and it pulls UNTRUSTED text off the internet into member
   * answers — which then feed the judge — so it must be an explicit choice.
   * Set per call by ask_council on a shallow clone of this config, never on
   * the shared server-wide one.
   */
  webAccess?: boolean;
  /** Max concurrent cloud requests — fallback default when a pool has no explicit limit. */
  cloudConcurrency: number;
  /** Max concurrent local requests. Default 1 (sequential) to avoid contention; <=0 = unlimited. */
  localConcurrency: number;
  /** Per-provider concurrency ceilings, derived from subscription tiers. */
  poolLimits: Record<PoolKey, number>;
  /** Attempts per completion before giving up on an empty/failed response. Default 3. */
  retries: number;
  /** Per-attempt wall-clock timeout (ms) for a single completion. Default 300000 (5 min). */
  requestTimeoutMs: number;
  /**
   * Per-attempt wall-clock timeout (ms) used INSTEAD of requestTimeoutMs when the
   * call has full_repo_access — repo-reading completions run longer (the CLI
   * member Read/Grep/Globs the tree), so they get a bigger budget. Default 600000 (10 min).
   * The orchestrator swaps this in on the per-call runtime clone when
   * fullRepoAccessRepo is set.
   */
  repoRequestTimeoutMs: number;
  /** Default value of the verbose flag for deconflicted results. */
  verbose: boolean;
  /**
   * Absolute repo root granted to full-repo-access-capable CLI members
   * (claude-cli/codex-cli) for the current ask() call, or undefined when off.
   * Set per-call by orchestrator.ask() on a shallow clone of this config —
   * never mutated on the shared server-wide RuntimeConfig, so concurrent
   * ask_council calls can't leak this into each other.
   */
  fullRepoAccess?: string;
}

// ─── Raw responses ────────────────────────────────────────────────────────────

/**
 * Which deliberation round produced an answer.
 *
 * Rounds are already separated STRUCTURALLY — each is a distinct awaited call
 * whose results land in their own array, at a fixed per-member index, so a slow
 * member's answer can never arrive late and be collected into the next round.
 * This tag is defense in depth on top of that: it puts the round on the RECORD
 * rather than leaving it implied by whichever array the record happens to sit
 * in, so a future refactor that merges, re-orders, or forwards responses
 * between collections can't silently turn a thesis into an antithesis. It is
 * also what lets a caller reading raw JSON tell the rounds apart without
 * knowing the container's field name.
 */
export type ResponsePhase =
  /** Round 0: each member's initial, independent answer. Every mode has one. */
  | 'thesis'
  /** dialectic: defend your own initial pick and argue the alternatives are worse. */
  | 'antithesis'
  /** dialectic: final ranked re-selection, made after weighing the pros/cons dossier. */
  | 'synthesis'
  /** pooled: a fresh answer given after seeing the neutral, attribution-free pool. */
  | 'reconsidered'
  /** deconflicted: a re-question aimed at the open conflicts; see `round` for which pass. */
  | 'deconflict';

export interface RawResponse {
  modelId: ModelId;
  label: string;
  response: string;
  error?: string;
  latencyMs: number;
  /** Which round produced this answer (see ResponsePhase). */
  phase?: ResponsePhase;
  /** 1-based deconfliction round. Only set when `phase` is 'deconflict'. */
  round?: number;
}

/**
 * Present on a result only when the ask attached images: records which
 * configured members actually received them (probe-confirmed vision-capable)
 * versus which were skipped because they aren't — so the routing decision is
 * visible, not silent.
 */
/**
 * Which members actually researched, when web_access was on. Reported for the
 * same reason as VisionRouting: only members driven through an agentic CLI
 * harness can run a search, so a mixed council would otherwise present
 * researched answers and recalled ones side by side as if they were peers —
 * and the judge would reconcile them as peers too. Making the split visible is
 * what stops "the council checked" from being read into an answer half of it
 * guessed at.
 */
export interface WebRouting {
  /** Members that were granted, and could actually run, a live web search. */
  researched: string[];
  /**
   * Members answering from training data alone, with why — an OpenAI-style
   * API member has no tool loop to grant, so it cannot research at all.
   */
  fromMemory: { label: string; reason: string }[];
  /** Members re-pointed through the claude-CLI harness so they COULD research. */
  routedViaHarness?: string[];
}

export interface VisionRouting {
  imagesAttached: number;
  queriedVisionModels: string[];
  skippedNonVision: string[];
}

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface IndividualResult {
  mode: 'individual';
  question: string;
  responses: RawResponse[];
  /** Set when a reconciliation mode fell back to individual (e.g. the judge failed). */
  note?: string;
  visionRouting?: VisionRouting;
  /** Present only when web_access was on — see WebRouting. */
  webRouting?: WebRouting;
  /**
   * Labels of members whose completion was cut by the per-completion timeout,
   * attached by the orchestrator from the raw responses it has in hand — so a
   * timeout is surfaced even under `verbose: false`, where the per-round
   * RawResponse[] fields that carry the error are omitted from the result.
   * Read by index.ts to add the top-level `timeoutNotice`.
   */
  timedOutMembers?: string[];
}

export interface ComplementaryItem {
  aspect: string;
  models: string[];       // model labels
  insight: string;
}

export interface ConflictPosition {
  models: string[];       // model labels
  position: string;
}

export interface ConflictItem {
  id: string;             // unique within result (conflict-1, conflict-2, …)
  topic: string;
  positions: ConflictPosition[];
  resolved?: boolean;
  resolution?: string;
}

export interface CategorizedResult {
  mode: 'categorized';
  question: string;
  commonAgreement: string | null;
  complementary: ComplementaryItem[];
  conflicting: ConflictItem[];
  rawResponses: RawResponse[];
  judgeModel: string;     // label
  /**
   * True when the judge model produced no usable output or unparseable JSON
   * for this categorization. When true, `commonAgreement`/`complementary`/
   * `conflicting` are empty as a FALLBACK, not a genuine "council perfectly
   * agreed" finding — check this before trusting an empty `conflicting` array.
   */
  judgeDegraded?: boolean;
  /**
   * True only when the JUDGE ITSELF produced nothing usable (no output, or
   * unparseable/wrong-shaped JSON). Distinct from `judgeDegraded`, which is the
   * broader "don't read this as clean convergence" marker and is ALSO set for a
   * partial member outage. The deconfliction loop must stop on a judge failure
   * (its conflict list is meaningless) but must NOT stop merely because a member
   * timed out — that member may well answer next round.
   */
  judgeFailed?: boolean;
  visionRouting?: VisionRouting;
  /** Present only when web_access was on — see WebRouting. */
  webRouting?: WebRouting;
  /**
   * Labels of members whose completion was cut by the per-completion timeout,
   * attached by the orchestrator from the raw responses it has in hand — so a
   * timeout is surfaced even under `verbose: false`, where the per-round
   * RawResponse[] fields that carry the error are omitted from the result.
   * Read by index.ts to add the top-level `timeoutNotice`.
   */
  timedOutMembers?: string[];
}

export interface RoundSummary {
  round: number;
  conflictsEntering: number;
  conflictsResolved: number;
  conflictsRemaining: number;
}

/** Full detail of a single deconfliction round (included only when verbose). */
export interface DeconflictRoundDetail {
  round: number;
  conflictsEntering: number;
  responses: RawResponse[];
  commonAgreement: string | null;
  complementary: ComplementaryItem[];
  conflicting: ConflictItem[];
  resolved: ConflictItem[];
  remaining: ConflictItem[];
}

export interface DeconflictedResult {
  mode: 'deconflicted';
  question: string;
  roundsTaken: number;
  maxRounds: number;
  /**
   * 0-100, percentage of conflicts resolved — or `null` when the judge failed
   * before an initial conflict count could even be established, meaning no
   * genuine measurement exists at all. Null on ONLY: the judge produced no
   * usable/parseable output for the initial categorization. Never confuse
   * with a real 100 (all known conflicts resolved) or a real 0 (none were).
   */
  deconflictionScore: number | null;
  resolved: number;
  totalConflicts: number;
  finalSynthesis: string;
  unresolvedConflicts: ConflictItem[];
  roundHistory: RoundSummary[];
  judgeModel: string;     // label
  /**
   * True when a judge failure (no usable output, or unparseable JSON)
   * affected this run. Two distinct cases, both flagged the same way:
   *  - the INITIAL categorization failed → no conflict count could even be
   *    established → `deconflictionScore` is null (no measurement at all).
   *  - a LATER round's judge output failed → the loop stopped there rather
   *    than fabricating a resolution, so `deconflictionScore` is still a
   *    real number computed from whatever rounds did succeed, but treat it
   *    as a pessimistic LOWER BOUND: conflicts left "unresolved" may only
   *    look that way because the judge never got to re-assess them.
   * Never set on a genuine outcome (real 100%, real 0%, real partial score).
   */
  judgeDegraded?: boolean;
  /**
   * Diagnostic only — does NOT imply `judgeDegraded` and does not affect
   * `deconflictionScore`. True when some round had a member error that was
   * checked against every open conflict and provably did NOT affect any of
   * their resolutions (a transient, recovered outage). Surfaced so a caller
   * can see that something happened without the whole run being marked
   * untrustworthy over an absence that demonstrably didn't change the result —
   * unconditionally tainting the run on ANY round's member error, regardless
   * of whether it affected anything, trained callers to ignore the signal.
   */
  hadRecoveredMemberOutage?: boolean;
  // ── Verbose-only fields (present when verbose is requested) ──
  /** The initial fan-out responses from every council member. */
  initialResponses?: RawResponse[];
  /** The first-pass categorization before any deconfliction rounds. */
  initialCategorization?: {
    commonAgreement: string | null;
    complementary: ComplementaryItem[];
    conflicting: ConflictItem[];
  };
  /** Per-round detail: member responses and the judge's re-categorization. */
  rounds?: DeconflictRoundDetail[];
  visionRouting?: VisionRouting;
  /** Present only when web_access was on — see WebRouting. */
  webRouting?: WebRouting;
  /**
   * Labels of members whose completion was cut by the per-completion timeout,
   * attached by the orchestrator from the raw responses it has in hand — so a
   * timeout is surfaced even under `verbose: false`, where the per-round
   * RawResponse[] fields that carry the error are omitted from the result.
   * Read by index.ts to add the top-level `timeoutNotice`.
   */
  timedOutMembers?: string[];
}

// ─── Pooled (Delphi) result ───────────────────────────────────────────────────

export interface PooledOption {
  /** The distinct answer (city, language, state, …). */
  answer: string;
  /** Reasoning merged from every response that offered this answer. */
  rationale: string;
  /**
   * Labels of the responses that included this answer. Recorded for the caller's
   * analysis only — it is deliberately NOT shown back to members during re-poll,
   * so their reconsideration stays free of attribution/popularity cues.
   */
  models: string[];
}

export interface PooledDigest {
  options: PooledOption[];
  /**
   * True when the judge failed to produce usable/parseable output for THIS
   * pooling step — `options: []` is a fallback in that case, not a genuine
   * "nothing distinct to pool" result (which is rare but possible if every
   * source response errored). Mirrors `CategorizedResult.judgeDegraded`.
   */
  judgeDegraded?: boolean;
}

export interface PooledResult {
  mode: 'pooled';
  question: string;
  judgeModel: string;     // label
  /**
   * True when EITHER digest step degraded — the judge produced no usable output
   * for a pool, or a member outage meant a pool was distilled over an incomplete
   * council. Aggregated to the top level so a caller can check trustworthiness
   * uniformly across modes (CategorizedResult/DeconflictedResult/DialecticResult
   * all expose it here) instead of having to reach into initialPool/finalPool.
   */
  judgeDegraded?: boolean;
  /** Neutral pool distilled from the initial (round-0) answers. */
  initialPool: PooledDigest;
  /** Each member's fresh answer after seeing the neutral pool. */
  reconsidered: RawResponse[];
  /** Neutral pool distilled from the reconsidered answers (no winner declared). */
  finalPool: PooledDigest;
  // ── Verbose-only ──
  /** The initial fan-out responses from every council member. */
  initialResponses?: RawResponse[];
  visionRouting?: VisionRouting;
  /** Present only when web_access was on — see WebRouting. */
  webRouting?: WebRouting;
  /**
   * Labels of members whose completion was cut by the per-completion timeout,
   * attached by the orchestrator from the raw responses it has in hand — so a
   * timeout is surfaced even under `verbose: false`, where the per-round
   * RawResponse[] fields that carry the error are omitted from the result.
   * Read by index.ts to add the top-level `timeoutNotice`.
   */
  timedOutMembers?: string[];
}

// ─── Dialectic result (thesis → antithesis → synthesis) ───────────────────────

export interface DialecticOption {
  /** The distinct answer under debate. */
  answer: string;
  /** Arguments in favour, drawn from the answer's champions and defenders. */
  pros: string[];
  /** Adverse arguments, drawn from members arguing the alternatives are better. */
  cons: string[];
  /**
   * Labels of the members that proposed this answer in the initial round.
   * Recorded for the caller's analysis.
   */
  championedBy: string[];
}

export interface DialecticResult {
  mode: 'dialectic';
  question: string;
  judgeModel: string;     // label
  /** Antithesis: each member defends its initial pick and critiques the alternatives. */
  defenses: RawResponse[];
  /** Synthesis dossier: pros/cons for each distinct option. */
  prosCons: DialecticOption[];
  /** Each member's final ranked top-3, chosen after weighing the pros/cons. */
  selections: RawResponse[];
  /**
   * True when a judge failure affected this run — either the initial digest
   * step (see `PooledDigest.judgeDegraded`) or the pros/cons dossier step.
   * `prosCons` still reflects the digest-seeded fallback sheet in that case,
   * not a genuine "nothing to debate" result.
   */
  judgeDegraded?: boolean;
  // ── Verbose-only ──
  /** Thesis: the initial fan-out responses from every council member. */
  initialResponses?: RawResponse[];
  visionRouting?: VisionRouting;
  /** Present only when web_access was on — see WebRouting. */
  webRouting?: WebRouting;
  /**
   * Labels of members whose completion was cut by the per-completion timeout,
   * attached by the orchestrator from the raw responses it has in hand — so a
   * timeout is surfaced even under `verbose: false`, where the per-round
   * RawResponse[] fields that carry the error are omitted from the result.
   * Read by index.ts to add the top-level `timeoutNotice`.
   */
  timedOutMembers?: string[];
}

export type CouncilResult =
  | IndividualResult
  | CategorizedResult
  | DeconflictedResult
  | PooledResult
  | DialecticResult;

// ─── Server connectivity ──────────────────────────────────────────────────────

export interface ServerConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  label: string;
  /** CLI-backed providers (claude-cli): path to the executable. */
  command?: string;
  /** CLI-backed providers (claude-cli): model aliases to expose. */
  models?: string[];
  /**
   * claude-cli only: when set, this server drives the `claude` CLI's own
   * agentic harness (Read/Grep/Glob, full_repo_access's --add-dir) against
   * an Anthropic-Messages-API-compatible backend OTHER than the real
   * Anthropic API — e.g. a local Ollama server's native `/v1/messages`
   * endpoint — so an open-weight model gets genuine repo access by reusing
   * this harness, rather than the no-tool-use single-completion path every
   * other provider (Ollama, OpenAI-compatible, Anthropic API) has. These
   * members are NOT Claude and must never be labelled as such.
   */
  anthropicBaseUrl?: string;
}
