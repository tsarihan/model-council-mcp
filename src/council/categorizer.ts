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
} from '../types.js';
import { Provider } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { completeWithRetry, EmptyCompletionError } from './query.js';
import { UNTRUSTED_CONTENT_NOTICE } from './prompt-safety.js';

/** Completion tuning passed down to judge calls. */
export interface CompleteConfig {
  maxTokens: number;
  retries: number;
  /** Per-attempt wall-clock timeout (ms) for judge calls. */
  timeoutMs: number;
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

function parseCategorizationJSON(raw: string): RawCategorizationJSON {
  // Strip markdown code fences if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  return JSON.parse(stripped) as RawCategorizationJSON;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function categorize(
  question: string,
  responses: RawResponse[],
  judgeModelId: ModelId,
  judgeProvider: Provider,
  cc: CompleteConfig,
  existingConflictIds: string[] = [],
  openTopics: string[] = [],
): Promise<Omit<CategorizedResult, 'mode' | 'rawResponses'>> {
  const prompt = buildCategorizationPrompt(question, responses, openTopics);

  let rawJson: string;
  try {
    rawJson = await completeWithRetry(
      judgeProvider,
      judgeModelId.model,
      [{ role: 'user', content: prompt }],
      { jsonMode: true, temperature: 0.2, maxTokens: cc.maxTokens, timeoutMs: cc.timeoutMs },
      cc.retries,
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
    };
  }

  // Build stable IDs for conflicts
  const existingSet = new Set(existingConflictIds);
  let conflictCounter =
    existingConflictIds.length > 0
      ? Math.max(...existingConflictIds.map(id => parseInt(id.split('-')[1] ?? '0')))
      : 0;

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
