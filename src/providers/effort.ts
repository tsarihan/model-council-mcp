/**
 * Reasoning-effort vocabulary, shared by every provider.
 *
 * The council speaks ONE canonical scale; each backend supports a different
 * subset of it, so the mapping lives here — in one reviewable table — rather
 * than as six independent ad-hoc translations inside the providers.
 *
 * Values below were verified against the real backends, not inferred:
 *   - claude-cli: `claude --help` → "--effort <level>  Effort level for the
 *     current session (low, medium, high, xhigh, max)".
 *   - codex-cli:  `-c model_reasoning_effort=<x>`. The parameter's enum
 *     advertises the full canonical set, but the MODEL's own check is
 *     narrower — sending 'minimal' to the current default model is rejected
 *     (see CODEX_CLI_EFFORTS). The table follows the model, not the enum.
 *   - ollama:     `think: "<x>"` with a bogus value returned "must be \"high\",
 *     \"medium\", \"low\", \"max\", true, or false" (Ollama 0.32.5). Note there
 *     is no `minimal`/`xhigh`, and `none` is expressed as `think: false`.
 *   - grok-cli:   `--reasoning-effort <EFFORT>` is a FREE-FORM string that the
 *     CLI forwards to the xAI API (verified: a bogus value is not rejected at
 *     parse time), so an unsupported level would fail at request time and kill
 *     the member. Kept deliberately narrow (low/high) for that reason.
 *   - openai-compatible: OpenAI documents `reasoning_effort` with
 *     none/minimal/low/medium/high (newer models add xhigh); self-hosted vLLM /
 *     SGLang builds vary widely, so the provider ALSO drops the field and
 *     retries once if the server rejects it.
 *   - anthropic (API key): no effort enum at all — extended thinking takes a
 *     numeric `budget_tokens`, so the scale maps to a budget (see
 *     effortToThinkingBudget).
 */

/** The canonical scale, ordered from least to most reasoning. */
export const EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof EFFORT_ORDER)[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v);
}

/**
 * Map a requested level onto what a given backend actually accepts.
 *
 * Nearest by rank, preferring the level BELOW on a tie — asking for more
 * reasoning than a backend can give should land on its ceiling (Ollama has no
 * `xhigh`, so `xhigh` → `high`, not `max`), and asking for less than its floor
 * lands on its floor (claude-cli has no `none`, so `none` → `low`). Never
 * throws and never returns a value outside `supported`, so a member can't be
 * killed by a level its provider doesn't know.
 */
export function clampEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.includes(requested)) return requested;
  const want = EFFORT_ORDER.indexOf(requested);
  let best = supported[0];
  let bestScore = Infinity;
  for (const candidate of supported) {
    const rank = EFFORT_ORDER.indexOf(candidate);
    // +0.5 penalty for going UP, so an exact-distance tie resolves downward.
    const score = Math.abs(rank - want) + (rank > want ? 0.5 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** `claude --effort` (verified via `claude --help`). */
export const CLAUDE_CLI_EFFORTS: readonly ReasoningEffort[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
];

/**
 * `codex exec -c model_reasoning_effort=…`.
 *
 * `minimal` is DELIBERATELY absent even though the parameter's own enum lists
 * it: the enum is generic, but the model-level check is not. Verified live
 * against the current default model — a bogus value's 400 advertised
 * 'none','minimal','low','medium','high','xhigh','max', yet actually sending
 * 'minimal' returned "Unsupported value: 'minimal' is not supported with the
 * 'gpt-5.6-sol-…' model. Supported values are: 'none', 'low', 'medium',
 * 'high', 'xhigh', and 'max'." Since a rejected level kills the member, the
 * table follows what the models accept, not what the parameter advertises;
 * `minimal` clamps to `none` here (the downward tie-break — the nearest thing
 * codex has to "barely think") and stays available verbatim for the OpenAI-API
 * models that genuinely support it (see OPENAI_EFFORTS).
 */
export const CODEX_CLI_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
];

/**
 * `grok --reasoning-effort` is forwarded verbatim to the xAI API, which
 * documents only low/high for its reasoning models. An unsupported value fails
 * the request (not the arg parse), so this stays narrow on purpose.
 */
export const GROK_CLI_EFFORTS: readonly ReasoningEffort[] = ['low', 'high'];

/**
 * Ollama's `think` field. `none` is NOT in this list because Ollama expresses
 * it as the boolean `think: false` rather than a level — the provider handles
 * that case before clamping.
 */
export const OLLAMA_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'max'];

/**
 * OpenAI's documented `reasoning_effort` values. Self-hosted OpenAI-compatible
 * servers vary, so the provider also degrades gracefully at request time.
 */
export const OPENAI_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
];

/**
 * Anthropic's Messages API has no effort enum — extended thinking is bought
 * with a token budget instead. Returns the `budget_tokens` to request, or
 * `undefined` for the levels that mean "don't think at all".
 *
 * The budget is a FRACTION of the caller's output budget because the API
 * requires `budget_tokens < max_tokens` (thinking tokens are drawn from the
 * same allowance), and it is floored at the API's own 1024-token minimum —
 * a smaller budget is rejected outright.
 */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

const THINKING_FRACTION: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 0,
  low: 0.2,
  medium: 0.4,
  high: 0.6,
  xhigh: 0.75,
  max: 0.85,
};

export function effortToThinkingBudget(
  effort: ReasoningEffort,
  maxTokens: number,
): number | undefined {
  const fraction = THINKING_FRACTION[effort];
  if (!fraction) return undefined;
  const budget = Math.floor(maxTokens * fraction);
  // Below the API minimum there is no valid budget to request at all: bumping
  // it up to 1024 would violate budget < max_tokens for a small max_tokens,
  // so skip thinking entirely rather than sending a request that 400s.
  if (budget < ANTHROPIC_MIN_THINKING_BUDGET) {
    return maxTokens > ANTHROPIC_MIN_THINKING_BUDGET ? ANTHROPIC_MIN_THINKING_BUDGET : undefined;
  }
  return budget;
}
