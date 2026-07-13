// ─── Provider & Server types ──────────────────────────────────────────────────

export type ProviderType =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'vllm'
  | 'trtllm'
  | 'sglang';

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
}

export type CouncilResult = IndividualResult | CategorizedResult | DeconflictedResult;

// ─── Server connectivity ──────────────────────────────────────────────────────

export interface ServerConfig {
  id: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  label: string;
}
