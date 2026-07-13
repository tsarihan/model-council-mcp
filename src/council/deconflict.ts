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
import { Provider } from '../providers/base.js';
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
 * A conflict is considered resolved when all updated positions collapse to a
 * single unique stance (allowing minor wording differences — the judge model
 * decides, returning an empty conflicting array for that topic).
 */
function detectResolutions(
  previous: ConflictItem[],
  newCateg: Awaited<ReturnType<typeof categorize>>,
): { resolved: ConflictItem[]; remaining: ConflictItem[] } {
  const newConflictTopics = new Set(
    newCateg.conflicting.map(c => c.topic.toLowerCase()),
  );

  const resolved: ConflictItem[] = [];
  const remaining: ConflictItem[] = [];

  for (const prev of previous) {
    // A conflict is resolved if the judge no longer lists a conflict on this topic
    const stillConflicted = [...newConflictTopics].some(t =>
      t.includes(prev.topic.toLowerCase().slice(0, 15)) ||
      prev.topic.toLowerCase().includes(t.slice(0, 15)),
    );

    if (stillConflicted) {
      // Update with the judge's refreshed positions
      const updated = newCateg.conflicting.find(c =>
        c.topic.toLowerCase().includes(prev.topic.toLowerCase().slice(0, 15)) ||
        prev.topic.toLowerCase().includes(c.topic.toLowerCase().slice(0, 15)),
      );
      remaining.push(updated ?? prev);
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
      { temperature: 0.3, maxTokens: runtime.maxTokens },
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
  } = input;

  const cc = { maxTokens: runtime.maxTokens, retries: runtime.retries };
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
    // Nothing to deconflict — synthesize directly
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
      deconflictionScore: 100,
      resolved: 0,
      totalConflicts: 0,
      finalSynthesis: synthesis,
      unresolvedConflicts: [],
      roundHistory: [],
      judgeModel: judgeLabel,
      ...verboseFields,
    };
  }

  let openConflicts = [...initialConflicts];
  const allResolved: ConflictItem[] = [];
  const roundHistory: RoundSummary[] = [];
  const roundDetails: DeconflictRoundDetail[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const enteringCount = openConflicts.length;

    // ── Ask each council member about the open conflicts ──────────────────
    const roundPrompt = buildConflictRoundPrompt(question, openConflicts, round);
    const roundResponses = await queryMembers(roundPrompt, members, runtime);

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
      );
    } catch {
      // Judge failed — stop here
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
