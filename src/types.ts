// ─── Provider & Server types ──────────────────────────────────────────────────

export type ProviderType =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'vllm'
  | 'trtllm'
  | 'sglang'
  | 'claude-cli'
  | 'codex-cli';

export type ResponseMode =
  | 'individual'
  | 'categorized'
  | 'deconflicted'
  | 'pooled'
  | 'dialectic';

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
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'ollama-cloud'
  | 'local';

/** The user's selected subscription tiers (validated against subscriptions.json). */
export interface SubscriptionTiers {
  chatgpt: string;
  claude: string;
  ollama: string;
}

/**
 * Runtime tuning knobs, set via environment / plugin userConfig.
 */
export interface RuntimeConfig {
  /** Max tokens requested per completion (default 16000). */
  maxTokens: number;
  /** Max concurrent cloud requests — fallback default when a pool has no explicit limit. */
  cloudConcurrency: number;
  /** Max concurrent local requests. Default 1 (sequential) to avoid contention; <=0 = unlimited. */
  localConcurrency: number;
  /** Per-provider concurrency ceilings, derived from subscription tiers. */
  poolLimits: Record<PoolKey, number>;
  /** Attempts per completion before giving up on an empty/failed response. Default 3. */
  retries: number;
  /** Per-attempt wall-clock timeout (ms) for a single completion. Default 120000. */
  requestTimeoutMs: number;
  /** Default value of the verbose flag for deconflicted results. */
  verbose: boolean;
}

// ─── Raw responses ────────────────────────────────────────────────────────────

export interface RawResponse {
  modelId: ModelId;
  label: string;
  response: string;
  error?: string;
  latencyMs: number;
}

/**
 * Present on a result only when the ask attached images: records which
 * configured members actually received them (probe-confirmed vision-capable)
 * versus which were skipped because they aren't — so the routing decision is
 * visible, not silent.
 */
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
  visionRouting?: VisionRouting;
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
  /** 0-100, percentage of conflicts resolved */
  deconflictionScore: number;
  resolved: number;
  totalConflicts: number;
  finalSynthesis: string;
  unresolvedConflicts: ConflictItem[];
  roundHistory: RoundSummary[];
  judgeModel: string;     // label
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
}

export interface PooledResult {
  mode: 'pooled';
  question: string;
  judgeModel: string;     // label
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
  // ── Verbose-only ──
  /** Thesis: the initial fan-out responses from every council member. */
  initialResponses?: RawResponse[];
  visionRouting?: VisionRouting;
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
}
