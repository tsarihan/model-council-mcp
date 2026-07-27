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
  // Preserve every PRIOR party model the judge did NOT re-list this round, at the
  // MODEL level — not the whole position. A prior position `[A, B]` where only A
  // is re-listed must still keep B represented: dropping the whole position (the
  // earlier bug) loses B, so a later round where B errors can't be recognised as
  // a dropout and the conflict is falsely resolved. Carry each dropped model as a
  // trimmed copy of its original position so positions[].models stays a superset
  // of every party ever seen.
  const preserved: ConflictPosition[] = [];
  for (const p of prev) {
    const droppedModels = (p.models ?? []).filter(m => !updatedModels.has(m));
    if (droppedModels.length) preserved.push({ ...p, models: droppedModels });
  }
  return [...updated, ...preserved];
}

/**
 * Did any party to this conflict error in the round just run?
 *
 * The two label sources are NOT the same trust level: `erroredLabels` are REAL
 * member labels from roundResponses, while `positions[].models` is whatever the
 * JUDGE wrote — untrusted text that may abbreviate ("a" for "ollama:a"), change
 * case, or add adornment. An exact `Set.has` therefore silently fails to
 * recognise a dropped party whenever the judge didn't echo the label verbatim,
 * defeating the party-outage guard and letting a member outage be reported as a
 * resolution. Match tolerantly (exact → case-insensitive → containment either
 * way, with a length floor so a 1-char token can't match everything); a false
 * MATCH is merely pessimistic (a conflict is carried forward), while a false
 * MISS fabricates consensus — so lean toward matching.
 */
/**
 * A position is "unattributed" when it carries no usable party label: no
 * `models` array, an empty one, OR one whose entries are all empty/whitespace
 * OR NON-STRING. The categorization schema requires `models` to be an array
 * of strings but sets no minItems and no non-empty constraint, so a judge can
 * emit `models: [""]` (or `["", "  "]`) — schema-valid under constrained
 * decoding. Treating such a position as ATTRIBUTED (array length 1) defeated
 * both the all-unattributed guard (`.every(length === 0)`) and the
 * mixed-attribution guard (`.some(length === 0)`): a single `[""]`-party
 * conflict whose (unlabelled) member errored was falsely RESOLVED, because
 * `partyErrored` skips empty strings too — nothing matched, so it fell to the
 * resolved branch. This helper is the single notion of "has a real party
 * label" shared by both carry-forward guards, so `[""]` is handled identically
 * to `[]`.
 *
 * Round-18 mechanism 17 (codex + kimi): the guard must require a STRING label,
 * not merely a non-empty one. `String(0)` is `"0"` and `String(false)` is
 * `"false"` — both non-empty — so the prior `!String(m ?? '').trim()` form
 * treated `models: [0]` as ATTRIBUTED. Exploit: the judge mis-attributes a
 * real member's stance to `[0]` instead of `["ollama:a"]`; that member then
 * errors; the judge (which filters errored responses) reports `conflicting:
 * []`; `noAttribution([0])` was false and `partyErrored` couldn't match `"0"`
 * against the errored label, so the conflict fell to the RESOLVED branch — a
 * fabricated `deconflictionScore: 100` with no `judgeDegraded`, even though
 * the real party never participated. A model label is, by definition, a
 * string; a non-string entry is a judge shape error, not an attribution, so
 * it counts as no label. `["a", ""]` still counts as attributed (it has a real
 * string label); `["a", 0]` is MIXED (some unattributed) and falls to the
 * mixed guard.
 */
function noAttribution(p: ConflictPosition): boolean {
  return (p.models ?? []).every(m => typeof m !== 'string' || !m.trim());
}

function partyErrored(positions: ConflictPosition[], erroredLabels: Set<string>): boolean {
  if (erroredLabels.size === 0) return false;
  const errored = [...erroredLabels];
  return positions.some(p =>
    (p.models ?? []).some(raw => {
      const m = String(raw ?? '').trim();
      if (!m) return false;
      if (erroredLabels.has(m)) return true;
      const lm = m.toLowerCase();
      return errored.some(e => {
        const le = e.toLowerCase();
        if (le === lm) return true;
        return lm.length >= 3 && le.length >= 3 && (le.includes(lm) || lm.includes(le));
      });
    }),
  );
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
  // Track CONSUMED new conflicts by INDEX, not by topic string. Keying on the
  // normalized topic would make two DISTINCT new conflicts that merely normalize
  // to the same string (e.g. two topic-less conflicts both coerced to 'unknown'
  // by categorizer, or 'Retry Strategy' vs 'retry  strategy') collide, and the
  // carry-forward loop below would silently drop the second one — a real live
  // disagreement absent from remaining/openConflicts/unresolvedConflicts/synthesis.
  const matchedNewIdx = new Set<number>();
  let partyDropout = false;

  for (const prev of previous) {
    const prevTopic = norm(prev.topic);
    // A conflict is resolved if the judge no longer lists a conflict on this topic.
    // Skip indices already consumed by an earlier previous-conflict: when TWO
    // previous conflicts normalize to the same topic, an unguarded findIndex
    // returns the SAME new conflict for both, so it gets pushed into `remaining`
    // twice (duplicated under two different ids) and inflates the open-conflict
    // count. Each new conflict may satisfy at most one previous conflict.
    const updatedIdx = newCateg.conflicting.findIndex(
      (c, i) => !matchedNewIdx.has(i) && norm(c.topic) === prevTopic,
    );
    const updated = updatedIdx >= 0 ? newCateg.conflicting[updatedIdx] : undefined;
    // The judge DID still report this topic, but the only entry for it was
    // already consumed by an earlier previous-conflict with the same normalized
    // topic. Round 12 added the skip to stop ONE new conflict being duplicated
    // across two previous ones — but "no unconsumed match" then fell through to
    // the resolved branch, so the second conflict was declared RESOLVED even
    // though the judge never said it had gone away. That is a fabricated
    // resolution; carry it forward instead (pessimistic and honest).
    const topicStillReported =
      updated === undefined && newCateg.conflicting.some(c => norm(c.topic) === prevTopic);

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
      matchedNewIdx.add(updatedIdx);
    } else if (topicStillReported) {
      remaining.push(prev);
    } else if ((prev.positions ?? []).every(p => noAttribution(p))) {
      // A conflict with NO party attached (the judge emitted a topic but no
      // positions, or positions with empty/whitespace-only models — see
      // noAttribution for the `[""]` edge) cannot be SHOWN to have
      // resolved: there is nobody whose changed stance could demonstrate it, and
      // the party-outage guard below has nothing to match either. Treating the
      // topic's absence as resolution turns a degenerate judge entry into a
      // clean 100. Carry it forward and mark the run degraded instead.
      remaining.push(prev);
      partyDropout = true;
    } else if (
      erroredLabels.size > 0 &&
      (prev.positions ?? []).some(p => noAttribution(p))
    ) {
      // MIXED attribution: not every position is unlabeled (the branch above
      // would have caught that), but AT LEAST ONE is — a real, live gap in the
      // categorization schema, which requires `models` to be an array but sets
      // no minItems (and no non-empty constraint — a `[""]` position counts
      // here too via noAttribution), so a judge emitting `models: []` (or
      // `[""]`) for a position it
      // couldn't confidently attribute is schema-valid even under constrained
      // decoding. partyErrored can only match an errored label against a
      // position that NAMES a model; it has nothing to compare an unattributed
      // position to, so it cannot rule out that the very member who errored
      // this round is the unnamed author of that position. Reproduced: a
      // conflict with one attributed + one unattributed position, an unrelated
      // member erroring, and the topic dropping from the judge's report was
      // marked RESOLVED with partyDropout left false. Since SOME member did
      // error this round, treat the ambiguity conservatively — carry forward
      // and flag degraded — rather than risk crediting a resolution no party
      // can be shown to have actually made.
      remaining.push(prev);
      partyDropout = true;
    } else if (partyErrored(prev.positions, erroredLabels)) {
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

  // Anything the judge reported this round that wasn't CONSUMED as a previous
  // conflict's update (by index — see the correctness note above) is carried
  // forward: a genuinely new/reworded conflict, or a distinct conflict that
  // merely shares a normalized topic with one already matched.
  newCateg.conflicting.forEach((c, i) => {
    if (!matchedNewIdx.has(i)) {
      remaining.push(c);
    }
  });

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
  // Diagnostic-only: a round had a member error that provably did NOT affect
  // any conflict resolution. Never elevates judgeDegraded on its own.
  let hadRecoveredMemberOutage = false;

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
        // ALL ids issued so far, not just the still-open ones: the counter is
        // seeded from max(id) downstream, so omitting already-RESOLVED ids lets it
        // REGRESS once a high-numbered conflict resolves and re-issue that id to a
        // brand-new conflict — breaking the cross-round id correlation this loop
        // depends on (and making two different conflicts indistinguishable to a
        // caller reading initialCategorization/rounds/unresolvedConflicts).
        [...allResolved, ...openConflicts].map(c => c.id),
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

    // Break ONLY on a genuine judge failure. Using the broader `judgeDegraded`
    // here was a regression: that flag is also set for a PARTIAL member outage,
    // so one member timing out in round 1 aborted the entire deconfliction loop
    // and reported it as a judge failure — when the judge worked fine and the
    // member would likely have answered next round.
    if (newCateg.judgeFailed) {
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
    // A degraded-but-usable round (e.g. partial member outage) does NOT stop the
    // loop, but the run is no longer a clean measurement.
    const erroredLabels = new Set(roundResponses.filter(r => r.error).map(r => r.label));
    const { resolved, remaining, partyDropout } = detectResolutions(openConflicts, newCateg, erroredLabels);
    if (partyDropout) {
      // detectResolutions ONLY sets this when an outage-related ambiguity
      // actually prevented a conflict from being silently resolved/discarded —
      // i.e. the absence demonstrably affected this round's outcome. That is a
      // genuine reason to distrust the run.
      partyDropoutDegraded = true;
    } else if (newCateg.judgeDegraded) {
      // A member errored THIS round (categorize() flags any partial outage),
      // but none of the currently-open conflicts were resolved/discarded as a
      // result — detectResolutions checked every one and found no ambiguity.
      // Unconditionally sticking `judgeDegraded` on this alone (the previous
      // behavior) meant a single transient hiccup in round 1 permanently
      // tainted a run that went on to fully resolve everything with complete
      // participation in every later round — round-16 council review flagged
      // this as flag fatigue: over-broad enough to train callers to ignore the
      // signal. Track it as diagnostic metadata instead, without elevating it.
      hadRecoveredMemberOutage = true;
    }
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
    // — a dropout only ever CARRIES FORWARD, never resolves — so a run that
    // reached a clean 100% did so in rounds where the party was present, and
    // the result is trustworthy; the dropout only deferred, it did not
    // fabricate. Conditioning partyDropoutDegraded on `openConflicts.length`
    // below makes the code match that reasoning. Three independent council
    // members (codex/kimi/deepseek, round 17) flagged the prior unconditional
    // OR as flag fatigue: a single early-round dropout permanently tainted a
    // run that went on to fully resolve everything with complete participation.)
    // ALSO propagate an already-degraded INITIAL categorization: `totalConflicts`
    // (the score's denominator) is fixed from it, so if that measurement was
    // taken over an incomplete council or a failed judge, every score derived
    // from it is likewise unreliable — even when the loop itself ran cleanly and
    // resolved everything. This one IS unconditional: the denominator itself is
    // suspect, so even a 100% over a degraded initial count is not a clean
    // measurement (unlike partyDropoutDegraded, which only ever defers a
    // resolution that later clean rounds can genuinely complete).
    // `partyDropoutDegraded` is set only when an outage-driven ambiguity
    // demonstrably prevented a conflict from resolving/discarding cleanly (see
    // detectResolutions) — NOT merely because some round had a member error.
    // (A round with an unrelated member error but no affected conflict sets
    // `hadRecoveredMemberOutage` below instead, without elevating this flag.)
    ...(midLoopJudgeFailure
        || input.judgeDegraded
        || (partyDropoutDegraded && openConflicts.length > 0)
      ? { judgeDegraded: true }
      : {}),
    ...(hadRecoveredMemberOutage ? { hadRecoveredMemberOutage: true } : {}),
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
