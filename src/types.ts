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

export type ResponseMode = 'individual' | 'categorized' | 'deconflicted';

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
 * Runtime tuning knobs, set via environment / plugin userConfig.
 */
export interface RuntimeConfig {
  /** Max tokens requested per completion (default 16000). */
  maxTokens: number;
  /** Max concurrent cloud requests (Ollama :cloud / OpenAI / Anthropic / Groq). Default 3. */
  cloudConcurrency: number;
  /** Max concurrent local requests. Default 1 (sequential) to avoid contention; <=0 = unlimited. */
  localConcurrency: number;
  /** Attempts per completion before giving up on an empty/failed response. Default 3. */
  retries: number;
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

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface IndividualResult {
  mode: 'individual';
  question: string;
  responses: RawResponse[];
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
}

export type CouncilResult = IndividualResult | CategorizedResult | DeconflictedResult;

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
