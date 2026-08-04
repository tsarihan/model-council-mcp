/**
 * Asks the judge model to categorize a set of council responses into:
 *   • commonAgreement – what all (or most) models agree on
 *   • complementary   – compatible but distinct insights
 *   • conflicting     – genuine contradictions
 */
import {
  CategorizedResult,
  ComplementaryItem,
  ConflictItem,
  ConflictPosition,
  ModelId,
  RawResponse,
  ReasoningEffort,
  RuntimeConfig,
} from '../types.js';
import { Provider, parseJudgeJson } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { EmptyCompletionError, pooledComplete } from './query.js';
import { UNTRUSTED_CONTENT_NOTICE } from './prompt-safety.js';

/** Completion tuning passed down to judge calls. */
export interface CompleteConfig {
  maxTokens: number;
  retries: number;
  /** Per-attempt wall-clock timeout (ms) for judge calls. */
  timeoutMs: number;
  /**
   * Reasoning depth for judge calls — the SAME council-wide level the members
   * ran at (see RuntimeConfig.reasoningEffort). Undefined leaves the judge at
   * its model's own default.
   */
  effort?: ReasoningEffort;
}

// ─── Judge prompt ─────────────────────────────────────────────────────────────

export function buildCategorizationPrompt(
  question: string,
  responses: RawResponse[],
  openTopics: string[] = [],
): string {
  const responseBlock = responses
    .filter(r => !r.error)
    .map(r => `### ${r.label}\n${r.response}`)
    .join('\n\n');

  // Only present in a deconfliction ROUND call (deconflict.ts), never the
  // initial categorization — see detectResolutions() in deconflict.ts, which
  // depends on the judge reusing these EXACT strings to tell "still the same
  // open conflict, reworded" apart from "genuinely resolved." Without this,
  // the judge free-invents a topic string each round purely from the round's
  // raw text, and innocuous rephrasing ("retry strategy" → "backoff
  // approach") reads as the conflict having vanished — fabricating
  // convergence that never actually happened.
  const openTopicsBlock = openTopics.length
    ? `\nThese conflict topics are still OPEN from the previous round — if a response ` +
      `below still reflects genuine disagreement on one of them, reuse its EXACT topic ` +
      `string verbatim (do not rephrase, expand, or abbreviate it) in your "topic" field. ` +
      `Only write a new topic string for a genuinely different conflict not in this list:\n` +
      openTopics.map(t => `- "${t}"`).join('\n') + '\n'
    : '';

  return `You are a neutral analyst comparing responses from multiple AI models.

Question asked to all models:
"""
${question}
"""

${UNTRUSTED_CONTENT_NOTICE}

Model responses:
${responseBlock}
${openTopicsBlock}
Categorize these responses. Return ONLY valid JSON with this exact schema (no markdown):
{
  "commonAgreement": "<summary of what all/most models agree on, or null if none>",
  "complementary": [
    { "aspect": "<topic>", "models": ["<model label>", ...], "insight": "<unique contribution>" }
  ],
  "conflicting": [
    {
      "topic": "<conflict topic>",
      "positions": [
        { "models": ["<model label>", ...], "position": "<their stance>" }
      ]
    }
  ]
}

Rules:
- "conflicting" only for genuine contradictions — not just different wording.
- "complementary" for different-but-compatible angles.
- Use the exact model labels provided above.
- Empty arrays [] are valid if there are no items in that category.`;
}

// ─── JSON parsing with fallback ───────────────────────────────────────────────

interface RawCategorizationJSON {
  commonAgreement?: string | null;
  complementary?: Array<{ aspect?: string; models?: string[]; insight?: string }>;
  conflicting?: Array<{
    topic?: string;
    positions?: Array<{ models?: string[]; position?: string }>;
  }>;
}

/** Schema for constrained decoding where the surface supports it (see CompletionOptions.jsonSchema). */
const CATEGORIZATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    commonAgreement: { type: ['string', 'null'] },
    complementary: { type: 'array', items: { type: 'object', properties: {
      aspect: { type: 'string' }, models: { type: 'array', items: { type: 'string' } }, insight: { type: 'string' },
    }, required: ['aspect', 'models', 'insight'] } },
    conflicting: { type: 'array', items: { type: 'object', properties: {
      topic: { type: 'string' },
      positions: { type: 'array', items: { type: 'object', properties: {
        models: { type: 'array', items: { type: 'string' } }, position: { type: 'string' },
      }, required: ['models', 'position'] } },
    }, required: ['topic', 'positions'] } },
  },
  required: ['commonAgreement', 'complementary', 'conflicting'],
};

function parseCategorizationJSON(raw: string): RawCategorizationJSON {
  // Strip markdown code fences if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  // Tolerate a prose preamble/postamble around the JSON object — matches the
  // same fallback pool.ts/dialectic.ts's parsers already have. This matters
  // most exactly where jsonMode is weakest: claude-cli/codex-cli/grok-cli have
  // no structured-output mode at all (jsonMode there is just an appended
  // instruction sentence), so a preamble like "Here is the categorization:\n{…}"
  // is a real, reproducible failure mode for the two DEFAULT response modes.
  // `conflicting` is the DECISIVE field — it alone drives the consensus/score
  // result, so it must be present AND an array. (`complementary`/`commonAgreement`
  // missing is benign: it loses detail but cannot fabricate convergence.)
  // parseJudgeJson tries every balanced object LAST-first, so a schema echo or
  // worked example preceding the real answer can't be parsed in its place.
  return parseJudgeJson<RawCategorizationJSON>(raw, { conflicting: 'array' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function categorize(
  question: string,
  responses: RawResponse[],
  judgeModelId: ModelId,
  judgeProvider: Provider,
  cc: CompleteConfig,
  runtime: RuntimeConfig,
  existingConflictIds: string[] = [],
  openTopics: string[] = [],
): Promise<Omit<CategorizedResult, 'mode' | 'rawResponses'>> {
  // No member actually answered this round (every response errored, or none
  // were queried at all) — there is nothing genuine to categorize. Without
  // this guard, the judge receives an empty "Model responses:" block and can
  // validly return an empty conflicting[]/complementary[], which reads as a
  // confident zero-conflict consensus rather than the truth: no data existed
  // to reach one. Skip the judge call entirely (nothing to spend it on) and
  // flag it exactly like a judge failure — every caller already treats
  // judgeDegraded as "don't trust this as genuine convergence."
  if (responses.length === 0 || responses.every(r => r.error)) {
    return {
      question,
      commonAgreement: null,
      complementary: [],
      conflicting: [],
      judgeModel: modelIdLabel(judgeModelId),
      judgeDegraded: true,
      judgeFailed: true, // no usable input existed at all
    };
  }

  // PARTIAL outage: some members answered, some errored. The judge only ever
  // sees the non-errored responses, so whatever it concludes is measured over an
  // INCOMPLETE council — and the missing members are exactly the ones that might
  // have disagreed. In the limit (2 of 3 members error) the judge sees a single
  // answer, cannot possibly find a contradiction, and returns conflicting: [] —
  // which downstream reads as a confident 100% consensus. That is the same
  // fabricated-convergence class the all-errored guard above prevents, just
  // reached through a partial rather than total outage, so flag it the same way:
  // the categorization still runs (its content is useful), but it is marked as
  // not-fully-trustworthy convergence rather than a clean measurement.
  const partialOutage = responses.some(r => r.error);

  const prompt = buildCategorizationPrompt(question, responses, openTopics);

  let rawJson: string;
  try {
    rawJson = await pooledComplete(
      { modelId: judgeModelId, provider: judgeProvider },
      [{ role: 'user', content: prompt }],
      { jsonMode: true, jsonSchema: CATEGORIZATION_SCHEMA, temperature: 0.2, maxTokens: cc.maxTokens, timeoutMs: cc.timeoutMs, effort: cc.effort },
      cc.retries,
      runtime,
    );
  } catch (err) {
    // Judge produced no usable output after all retries → degrade gracefully
    // rather than failing the whole request, matching the JSON-parse fallback
    // below. `judgeDegraded: true` marks this an INDETERMINATE result, not a
    // confident "no conflicts found" — without it, a judge outage is
    // indistinguishable from genuine 100% consensus (see deconflict.ts, which
    // reads this flag before trusting an empty `conflicting` array). A genuine
    // provider error still propagates.
    if (err instanceof EmptyCompletionError) {
      return {
        question,
        commonAgreement: null,
        complementary: [],
        conflicting: [],
        judgeModel: modelIdLabel(judgeModelId),
        judgeDegraded: true,
        judgeFailed: true, // judge produced no usable output
      };
    }
    throw new Error(
      `Judge model (${modelIdLabel(judgeModelId)}) failed: ${String(err)}`,
    );
  }

  let parsed: RawCategorizationJSON;
  try {
    parsed = parseCategorizationJSON(rawJson);
  } catch {
    // Fallback: couldn't parse → same indeterminate marker as above.
    return {
      question,
      commonAgreement: null,
      complementary: [],
      conflicting: [],
      judgeModel: modelIdLabel(judgeModelId),
      judgeDegraded: true,
      judgeFailed: true, // unparseable / wrong-shaped judge JSON
    };
  }

  // Build stable IDs for conflicts
  const existingSet = new Set(existingConflictIds);
  // Only count ids that actually carry a numeric suffix. A single unparseable id
  // (a judge-supplied or hand-edited "conflict-abc", or a bare "conflict") makes
  // parseInt return NaN, and Math.max with any NaN is NaN — after which EVERY
  // generated id becomes "conflict-NaN", so ids stop being unique and the
  // cross-round id correlation that detectResolutions relies on breaks.
  const usedNumbers = existingConflictIds
    .map(id => parseInt(id.split('-')[1] ?? '', 10))
    .filter(n => Number.isFinite(n));
  let conflictCounter = usedNumbers.length > 0 ? Math.max(...usedNumbers) : 0;

  // Judge JSON is untrusted in SHAPE (jsonMode only guarantees parseable JSON, not
  // that these fields are arrays). Guard every .map with Array.isArray and coerce
  // topic to a string, so a bare object / scalar can't crash the whole request.
  const conflicting: ConflictItem[] = (Array.isArray(parsed.conflicting) ? parsed.conflicting : []).map(c => {
    conflictCounter++;
    const id = `conflict-${conflictCounter}`;
    return {
      id,
      topic: String(c?.topic ?? 'unknown'),
      positions: (Array.isArray(c?.positions) ? c.positions : []).map(p => ({
        models: Array.isArray(p?.models) ? p.models : [],
        position: String(p?.position ?? ''),
      })) as ConflictPosition[],
    };
  });

  return {
    question,
    commonAgreement: parsed.commonAgreement ?? null,
    complementary: (Array.isArray(parsed.complementary) ? parsed.complementary : []).map(c => ({
      aspect: String(c?.aspect ?? ''),
      models: Array.isArray(c?.models) ? c.models : [],
      insight: String(c?.insight ?? ''),
    })) as ComplementaryItem[],
    conflicting,
    judgeModel: modelIdLabel(judgeModelId),
    // Measured over an incomplete council (see partialOutage above) — the
    // categorization content is real, but it is not a clean convergence reading.
    ...(partialOutage ? { judgeDegraded: true } : {}),
  };
}

// ─── Synthesis prompt (used by deconflict.ts after final round) ───────────────

export function buildSynthesisPrompt(
  question: string,
  commonAgreement: string | null,
  complementary: ComplementaryItem[],
  resolvedConflicts: ConflictItem[],
  unresolvedConflicts: ConflictItem[],
): string {
  const parts: string[] = [
    `Synthesize a comprehensive final answer to this question:`,
    `"""`,
    question,
    `"""`,
    ``,
    UNTRUSTED_CONTENT_NOTICE,
    ``,
    `Council findings:`,
  ];

  if (commonAgreement) {
    parts.push(`Common agreement: ${commonAgreement}`);
  }

  if (complementary.length) {
    parts.push(`Complementary insights:`);
    complementary.forEach(c =>
      parts.push(`  - ${c.aspect}: ${c.insight}  [${c.models.join(', ')}]`),
    );
  }

  if (resolvedConflicts.length) {
    parts.push(`Resolved conflicts:`);
    resolvedConflicts.forEach(c =>
      parts.push(`  - ${c.topic}: ${c.resolution ?? 'consensus reached'}`),
    );
  }

  if (unresolvedConflicts.length) {
    parts.push(`Unresolved conflicts (note in answer):`);
    unresolvedConflicts.forEach(c => {
      parts.push(`  - ${c.topic}:`);
      c.positions.forEach(p =>
        parts.push(`      [${p.models.join(', ')}]: ${p.position}`),
      );
    });
  }

  parts.push(
    ``,
    `Write a clear, complete answer. Acknowledge unresolved disagreements where relevant.`,
  );

  return parts.join('\n');
}
