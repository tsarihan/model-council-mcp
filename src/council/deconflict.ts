/**
 * Iterative deconfliction loop.
 *
 * Round flow:
 *   1. Ask all council members about each open conflict point.
 *   2. Judge re-categorizes the new conflict responses.
 *   3. Any conflict where all positions converge is marked resolved.
 *   4. Repeat until no conflicts remain or maxRounds is exhausted.
 *   5. Score = resolvedCount / totalConflicts × 100.
 */
import {
  ComplementaryItem,
  ConflictItem,
  DeconflictedResult,
  DeconflictRoundDetail,
  ModelId,
  RawResponse,
  RoundSummary,
  RuntimeConfig,
} from '../types.js';
import { ChatImage, Provider } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { categorize, buildSynthesisPrompt } from './categorizer.js';
import { completeWithRetry, Member, queryMembers } from './query.js';

// ─── Round-query prompt ───────────────────────────────────────────────────────

function buildConflictRoundPrompt(
  originalQuestion: string,
  conflicts: ConflictItem[],
  round: number,
): string {
  const conflictLines = conflicts
    .map((c, i) => {
      const posLines = c.positions
        .map(p => `    • [${p.models.join(', ')}]: ${p.position}`)
        .join('\n');
      return `Conflict ${i + 1} — "${c.topic}":\n${posLines}`;
    })
    .join('\n\n');

  return `[Deconfliction round ${round}]

Original question:
"""
${originalQuestion}
"""

The following conflicts remain among council members:
${conflictLines}

For each conflict above, please do ONE of:
  A) Agree with one of the existing positions (state which and why).
  B) Propose a synthesis that resolves the conflict.
  C) Maintain your original position with a brief justification.

Be concise and direct.`;
}

// ─── Convergence check ────────────────────────────────────────────────────────

/**
 * A conflict is considered resolved when the judge no longer lists a conflict
 * matching its topic.
 *
 * Matching is EXACT (case/whitespace-normalized), not fuzzy. The previous
 * fuzzy 15-char-prefix substring match was a real correctness bug in the
 * flagship convergence metric: two DIFFERENT topics that happened to share a
 * short prefix could wrongly collapse together, and — far more commonly — the
 * SAME still-open conflict reworded by the judge between rounds ("retry
 * strategy" → "backoff approach for retries") would fail to overlap at all
 * and get silently marked RESOLVED, fabricating consensus that never
 * happened. buildCategorizationPrompt() (categorizer.ts) now feeds the round
 * call the current open topics and instructs the judge to reuse them
 * verbatim for a persisting conflict, which is what makes exact matching
 * viable — a judge that ignores the instruction and rewords anyway will
 * (correctly, if pessimistically) read as the old topic having resolved and
 * a new one appearing, rather than silently misattributing wording drift as
 * consensus.
 */
export function detectResolutions(
  previous: ConflictItem[],
  newCateg: Awaited<ReturnType<typeof categorize>>,
): { resolved: ConflictItem[]; remaining: ConflictItem[] } {
  // Coerce every topic to a string (a judge can emit a non-string topic) and
  // normalize case/whitespace so trivial formatting differences (not actual
  // rewording) don't cause a false non-match.
  const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const resolved: ConflictItem[] = [];
  const remaining: ConflictItem[] = [];

  for (const prev of previous) {
    const prevTopic = norm(prev.topic);
    // A conflict is resolved if the judge no longer lists a conflict on this topic.
    const updated = newCateg.conflicting.find(c => norm(c.topic) === prevTopic);

    if (updated) {
      remaining.push(updated);
    } else {
      resolved.push({
        ...prev,
        resolved: true,
        resolution: newCateg.commonAgreement ?? 'Council reached consensus.',
      });
    }
  }

  return { resolved, remaining };
}

// ─── Synthesis (graceful on empty/failed judge) ───────────────────────────────

async function synthesize(
  judgeProvider: Provider,
  model: string,
  prompt: string,
  runtime: RuntimeConfig,
): Promise<string> {
  try {
    return await completeWithRetry(
      judgeProvider,
      model,
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, maxTokens: runtime.maxTokens, timeoutMs: runtime.requestTimeoutMs },
      runtime.retries,
    );
  } catch {
    // Judge could not synthesize (empty or error after retries) — return the
    // fully computed deconfliction result rather than failing the whole request.
    return '(The judge model returned no final synthesis.)';
  }
}

// ─── Main deconfliction entry point ──────────────────────────────────────────

export interface DeconflictInput {
  question: string;
  initialResponses: RawResponse[];
  initialConflicts: ConflictItem[];
  commonAgreement: string | null;
  complementary: ComplementaryItem[];
  maxRounds: number;
  members: Member[];
  judgeModelId: ModelId;
  judgeProvider: Provider;
  runtime: RuntimeConfig;
  /** When true, the result includes the initial categorization and per-round detail. */
  verbose: boolean;
  /**
   * True when the initial categorization (categorize() upstream) failed to
   * produce usable output — `initialConflicts` is an empty FALLBACK, not a
   * genuine zero-conflict finding. Must not be reported as a confident 100%.
   */
  judgeDegraded?: boolean;
  /**
   * Re-attached to every round's member queries — a member re-examining a
   * conflict about an image must still be looking at it, not recalling its
   * own round-0 description. Never sent to the judge (categorize() works from
   * the members' text responses only).
   */
  images?: ChatImage[];
}

export async function deconflict(
  input: DeconflictInput,
): Promise<DeconflictedResult> {
  const {
    question,
    initialConflicts,
    maxRounds,
    members,
    judgeModelId,
    judgeProvider,
    runtime,
    verbose,
    images,
  } = input;

  const cc = {
    maxTokens: runtime.maxTokens, retries: runtime.retries, timeoutMs: runtime.requestTimeoutMs,
  };
  const judgeLabel = modelIdLabel(judgeModelId);
  const totalConflicts = initialConflicts.length;

  const verboseFields = verbose
    ? {
        initialResponses: input.initialResponses,
        initialCategorization: {
          commonAgreement: input.commonAgreement,
          complementary: input.complementary,
          conflicting: initialConflicts,
        },
        rounds: [] as DeconflictRoundDetail[],
      }
    : {};

  if (totalConflicts === 0) {
    // Nothing to deconflict — synthesize directly. But if the INITIAL
    // categorization itself was degraded (judge failure/unparseable output),
    // an empty conflict list is a fallback, not a genuine finding — reporting
    // a confident 100% here would fabricate the flagship convergence metric.
    const synthesis = await synthesize(
      judgeProvider,
      judgeModelId.model,
      buildSynthesisPrompt(
        question,
        input.commonAgreement,
        input.complementary,
        [],
        [],
      ),
      runtime,
    );
    return {
      mode: 'deconflicted',
      question,
      roundsTaken: 0,
      maxRounds,
      deconflictionScore: input.judgeDegraded ? null : 100,
      resolved: 0,
      totalConflicts: 0,
      finalSynthesis: synthesis,
      unresolvedConflicts: [],
      roundHistory: [],
      judgeModel: judgeLabel,
      ...(input.judgeDegraded ? { judgeDegraded: true } : {}),
      ...verboseFields,
    };
  }

  let openConflicts = [...initialConflicts];
  const allResolved: ConflictItem[] = [];
  const roundHistory: RoundSummary[] = [];
  const roundDetails: DeconflictRoundDetail[] = [];
  // Set when a round's judge output is missing/unparseable (thrown error OR
  // categorize()'s own graceful degrade). `resolved`/`totalConflicts`/score
  // still reflect a genuine measurement from whatever rounds DID succeed —
  // this only flags that a judge outage cut the loop short, so the resulting
  // score is a pessimistic lower bound (some "unresolved" conflicts may only
  // look that way because the judge never got to re-assess them), not
  // necessarily the council's true convergence.
  let midLoopJudgeFailure = false;

  for (let round = 1; round <= maxRounds; round++) {
    const enteringCount = openConflicts.length;

    // ── Ask each council member about the open conflicts ──────────────────
    const roundPrompt = buildConflictRoundPrompt(question, openConflicts, round);
    const roundResponses = await queryMembers(roundPrompt, members, runtime, {}, images);

    // ── Judge re-categorizes these round-specific responses ───────────────
    let newCateg: Awaited<ReturnType<typeof categorize>>;
    try {
      newCateg = await categorize(
        question,
        roundResponses,
        judgeModelId,
        judgeProvider,
        cc,
        openConflicts.map(c => c.id),
        openConflicts.map(c => c.topic),
      );
    } catch {
      // Judge failed — stop here
      midLoopJudgeFailure = true;
      roundHistory.push({
        round,
        conflictsEntering: enteringCount,
        conflictsResolved: 0,
        conflictsRemaining: enteringCount,
      });
      if (verbose) {
        roundDetails.push({
          round,
          conflictsEntering: enteringCount,
          responses: roundResponses,
          commonAgreement: null,
          complementary: [],
          conflicting: [],
          resolved: [],
          remaining: openConflicts,
        });
      }
      break;
    }

    if (newCateg.judgeDegraded) {
      // categorize() didn't throw, but only because it degrades gracefully to
      // an empty conflicting[] on judge failure/unparseable JSON (see
      // categorizer.ts). Left unchecked, detectResolutions() would read that
      // empty array as "the judge no longer sees any of these conflicts" and
      // mark every open conflict resolved — fabricating consensus from a
      // judge outage. Treat exactly like the genuine-error catch above: stop,
      // keep every open conflict as remaining, don't touch allResolved.
      midLoopJudgeFailure = true;
      roundHistory.push({
        round,
        conflictsEntering: enteringCount,
        conflictsResolved: 0,
        conflictsRemaining: enteringCount,
      });
      if (verbose) {
        roundDetails.push({
          round,
          conflictsEntering: enteringCount,
          responses: roundResponses,
          commonAgreement: null,
          complementary: [],
          conflicting: [],
          resolved: [],
          remaining: openConflicts,
        });
      }
      break;
    }

    // ── Detect resolved vs remaining conflicts ────────────────────────────
    const { resolved, remaining } = detectResolutions(openConflicts, newCateg);
    allResolved.push(...resolved);

    roundHistory.push({
      round,
      conflictsEntering: enteringCount,
      conflictsResolved: resolved.length,
      conflictsRemaining: remaining.length,
    });
    if (verbose) {
      roundDetails.push({
        round,
        conflictsEntering: enteringCount,
        responses: roundResponses,
        commonAgreement: newCateg.commonAgreement,
        complementary: newCateg.complementary,
        conflicting: newCateg.conflicting,
        resolved,
        remaining,
      });
    }

    openConflicts = remaining;
    if (openConflicts.length === 0) break;
  }

  // ── Final synthesis ───────────────────────────────────────────────────────
  const synthesis = await synthesize(
    judgeProvider,
    judgeModelId.model,
    buildSynthesisPrompt(
      question,
      input.commonAgreement,
      input.complementary,
      allResolved,
      openConflicts,
    ),
    runtime,
  );

  const resolvedCount = allResolved.length;
  const score =
    totalConflicts > 0
      ? Math.round((resolvedCount / totalConflicts) * 100)
      : 100;

  return {
    mode: 'deconflicted',
    question,
    roundsTaken: roundHistory.length,
    maxRounds,
    deconflictionScore: score,
    resolved: resolvedCount,
    totalConflicts,
    finalSynthesis: synthesis,
    unresolvedConflicts: openConflicts,
    roundHistory,
    judgeModel: judgeLabel,
    ...(midLoopJudgeFailure ? { judgeDegraded: true } : {}),
    ...(verbose
      ? {
          initialResponses: input.initialResponses,
          initialCategorization: {
            commonAgreement: input.commonAgreement,
            complementary: input.complementary,
            conflicting: initialConflicts,
          },
          rounds: roundDetails,
        }
      : {}),
  };
}
