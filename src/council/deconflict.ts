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
  ConflictPosition,
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
import { Member, pooledComplete, queryMembers } from './query.js';
import { UNTRUSTED_PEER_CONTENT_NOTICE } from './prompt-safety.js';

// ─── Round-query prompt ───────────────────────────────────────────────────────

export function buildConflictRoundPrompt(
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

${UNTRUSTED_PEER_CONTENT_NOTICE}

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
 * viable.
 *
 * CORRECTNESS-CRITICAL: any entry in `newCateg.conflicting` that does NOT
 * match a previous topic must still be carried into `remaining` — it is
 * either a genuinely new conflict, or (if the judge ignored the reuse
 * instruction) the SAME conflict under new wording. An earlier version of
 * this function only ever looked up matches FROM `previous` and silently
 * dropped any unmatched new entry, which meant a reworded topic read as
 * "old resolved" with the reworded replacement simply vanishing — the exact
 * fabricated-consensus bug this whole exact-match design exists to kill,
 * reintroduced through a different mechanism. Carrying it forward is
 * slightly pessimistic when the judge genuinely reworded the SAME conflict
 * (it then counts as both one resolution and one still-open item), but that
 * is a strict improvement over silently losing live disagreement — it keeps
 * `unresolvedConflicts` non-empty and the loop honest rather than letting it
 * falsely terminate at 100%.
 */
/**
 * Union two rounds' conflict positions BY MODEL LABEL: keep all of the judge's
 * fresh positions, plus any prior position whose parties are entirely absent
 * this round (a fully-dropped party, e.g. one that errored). This keeps every
 * party that has EVER been recorded for a conflict present in its positions, so
 * the party-dropout guard can still recognise a dropped member in a later round.
 */
function mergePositionsByModel(
  prev: ConflictPosition[],
  updated: ConflictPosition[],
): ConflictPosition[] {
  const updatedModels = new Set(updated.flatMap(p => p.models ?? []));
  const droppedParties = prev.filter(
    p => (p.models ?? []).length > 0 && !(p.models ?? []).some(m => updatedModels.has(m)),
  );
  return [...updated, ...droppedParties];
}

export function detectResolutions(
  previous: ConflictItem[],
  newCateg: Awaited<ReturnType<typeof categorize>>,
  erroredLabels: Set<string> = new Set(),
): { resolved: ConflictItem[]; remaining: ConflictItem[]; partyDropout: boolean } {
  // Coerce every topic to a string (a judge can emit a non-string topic) and
  // normalize case/whitespace so trivial formatting differences (not actual
  // rewording) don't cause a false non-match.
  const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  const resolved: ConflictItem[] = [];
  const remaining: ConflictItem[] = [];
  const matchedNewTopics = new Set<string>();
  let partyDropout = false;

  for (const prev of previous) {
    const prevTopic = norm(prev.topic);
    // A conflict is resolved if the judge no longer lists a conflict on this topic.
    const updated = newCateg.conflicting.find(c => norm(c.topic) === prevTopic);

    if (updated) {
      // Keep the ORIGINAL id stable across rounds (a fresh id from this
      // round's categorize() call would otherwise make the same persisting
      // conflict look like a different one to any caller correlating ids
      // across `initialCategorization`/`rounds`/`unresolvedConflicts`).
      //
      // Preserve any PARTY the judge dropped from this round's positions —
      // e.g. a member that errored this round is filtered out of the judge
      // prompt, so it won't appear in `updated.positions`. Replacing positions
      // wholesale would ERASE that party's label, and a LATER round where the
      // same member errors again would then find no party-in-positions match
      // and falsely resolve the conflict (defeating the dropout guard below).
      // Union by model label so the party set only ever grows.
      remaining.push({ ...updated, id: prev.id, positions: mergePositionsByModel(prev.positions, updated.positions) });
      matchedNewTopics.add(norm(updated.topic));
    } else if (prev.positions.some(p => (p.models ?? []).some(m => erroredLabels.has(m)))) {
      // The topic vanished from the judge's output — but a MEMBER that is a
      // PARTY to this conflict errored this round, and the judge only ever sees
      // non-errored responses (categorizer filters them out). So the judge
      // never heard that side's position: the topic's absence is a member
      // OUTAGE, not evidence of resolution. Marking it resolved here would
      // fabricate consensus and drive deconflictionScore up on a dropout with
      // no signal — the exact anti-false-consensus principle already applied to
      // judge outages. Carry it forward as still-open and flag the dropout so
      // the caller can mark the score a pessimistic lower bound.
      remaining.push(prev);
      partyDropout = true;
    } else {
      resolved.push({
        ...prev,
        resolved: true,
        resolution: newCateg.commonAgreement ?? 'Council reached consensus.',
      });
    }
  }

  // Anything the judge reported this round that didn't match a previous
  // topic — see the correctness note above.
  for (const c of newCateg.conflicting) {
    if (!matchedNewTopics.has(norm(c.topic))) {
      remaining.push(c);
    }
  }

  return { resolved, remaining, partyDropout };
}

// ─── Synthesis (graceful on empty/failed judge) ───────────────────────────────

async function synthesize(
  judgeProvider: Provider,
  judgeModelId: ModelId,
  prompt: string,
  runtime: RuntimeConfig,
): Promise<string> {
  try {
    return await pooledComplete(
      { modelId: judgeModelId, provider: judgeProvider },
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, maxTokens: runtime.maxTokens, timeoutMs: runtime.requestTimeoutMs },
      runtime.retries,
      runtime,
    );
  } catch {
    // Judge could not synthesize (empty or error after retries) — return the
    // fully computed deconfliction result rather than failing the whole request.
    return '(The judge model returned no final synthesis.)';
  }
}

// ─── Main deconfliction entry point ──────────────────────────────────────────

export interface DeconflictInput {
  /**
   * The (possibly augmented) question shown to MEMBERS in each round — it may
   * embed untrusted attachments/diff/repo content, which members are meant to
   * analyze. Never build a JUDGE prompt from this (see judgeQuestion).
   */
  question: string;
  /**
   * The ORIGINAL, pre-augmentation question, used for every JUDGE-facing prompt
   * (categorization, synthesis). The judge classifies member response TEXT and
   * does not need the raw attachments; routing the augmented question here would
   * embed untrusted content in a trust-affirming "question" block ABOVE the
   * untrusted-content notice, a prompt-injection vector into the judge. Defaults
   * to `question` when omitted (keeps direct callers/tests behaving as before).
   */
  judgeQuestion?: string;
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
  // Original question for judge prompts; augmented `question` for member rounds.
  const judgeQuestion = input.judgeQuestion ?? question;

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
      judgeModelId,
      buildSynthesisPrompt(
        judgeQuestion,
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
  // Set when a conflict was carried forward because one of ITS parties errored
  // that round (see detectResolutions) — the run couldn't fully assess that
  // conflict, so a residual open count is a pessimistic lower bound, not a
  // measured "still in disagreement". Distinct from midLoopJudgeFailure: a
  // party dropout does NOT stop the loop (the member may answer next round).
  let partyDropoutDegraded = false;

  for (let round = 1; round <= maxRounds; round++) {
    const enteringCount = openConflicts.length;

    // ── Ask each council member about the open conflicts ──────────────────
    const roundPrompt = buildConflictRoundPrompt(question, openConflicts, round);
    const roundResponses = await queryMembers(roundPrompt, members, runtime, {}, images);

    // ── Judge re-categorizes these round-specific responses ───────────────
    let newCateg: Awaited<ReturnType<typeof categorize>>;
    try {
      newCateg = await categorize(
        judgeQuestion,
        roundResponses,
        judgeModelId,
        judgeProvider,
        cc,
        runtime,
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
    // Pass the labels of members that errored THIS round so a conflict whose
    // party dropped out isn't fabricated into a resolution (see detectResolutions).
    const erroredLabels = new Set(roundResponses.filter(r => r.error).map(r => r.label));
    const { resolved, remaining, partyDropout } = detectResolutions(openConflicts, newCateg, erroredLabels);
    if (partyDropout) partyDropoutDegraded = true;
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
    judgeModelId,
    buildSynthesisPrompt(
      judgeQuestion,
      input.commonAgreement,
      input.complementary,
      allResolved,
      openConflicts,
    ),
    runtime,
  );

  // `allResolved` can include the eventual resolution of a conflict that was
  // only discovered mid-loop (detectResolutions()'s carry-forward above
  // deliberately keeps a reworded/new topic in play rather than dropping it),
  // which was never part of `totalConflicts` — that denominator is fixed at
  // the first round and does not grow for mid-loop discoveries. Precisely
  // attributing which original conflict a later resolution corresponds to
  // would need an ID-keyed judge protocol (out of scope here). Rather than
  // patch the attribution, keep the reported numbers honest by construction:
  // `resolved` can never exceed `totalConflicts`, and the score is 100 iff
  // nothing is left open — never 100 (or above) while `unresolvedConflicts`
  // is non-empty.
  const resolvedCount =
    totalConflicts > 0 ? Math.min(allResolved.length, totalConflicts) : allResolved.length;
  const score =
    totalConflicts <= 0
      ? 100
      : openConflicts.length > 0
        ? Math.min(99, Math.round((resolvedCount / totalConflicts) * 100))
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
    // Degraded when the judge failed mid-loop, OR when a party-dropout forced a
    // carry-forward AND the run still ends with open conflicts — in that case
    // some of what looks "unresolved" may only look that way because a party
    // was absent when the judge assessed it, so the score is a lower bound.
    // (If everything resolved, all resolutions happened in dropout-free rounds
    // — a dropout only ever carries forward — so the result is trustworthy.)
    ...(midLoopJudgeFailure || (partyDropoutDegraded && openConflicts.length > 0)
      ? { judgeDegraded: true }
      : {}),
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
