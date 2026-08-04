/**
 * Dialectic mode: thesis → antithesis → synthesis.
 *
 *   1. Thesis      — each member's initial independent answer (done upstream).
 *   2. Antithesis  — every member sees all the distinct options and is asked to
 *                    DEFEND its own initial pick and argue why the alternatives
 *                    are not better. This is adversarial and personalised.
 *   3. Dossier     — the judge distils those defenses/critiques into a balanced
 *                    pros/cons sheet for each option (arguments for + against).
 *   4. Synthesis   — every member re-selects a ranked top-3 from that dossier,
 *                    now weighing both sides of each option.
 *
 * Unlike `pooled` (which is deliberately neutral to avoid influence), `dialectic`
 * is deliberately adversarial: it surfaces the strongest case for AND against
 * every option before members choose, so a final pick has survived scrutiny.
 */
import {
  DialecticOption,
  DialecticResult,
  ModelId,
  PooledDigest,
  RawResponse,
  RuntimeConfig,
} from '../types.js';
import { ChatImage, Provider, parseJudgeJson } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { CompleteConfig } from './categorizer.js';
import {
  EmptyCompletionError,
  Member,
  pooledComplete,
  queryMembers,
  queryMembersVarying,
} from './query.js';
import { poolResponses } from './pool.js';
import { UNTRUSTED_CONTENT_NOTICE, UNTRUSTED_PEER_CONTENT_NOTICE } from './prompt-safety.js';

// ─── Step 2 prompt: defend your pick, critique the rest ──────────────────────

function renderOptions(digest: PooledDigest): string {
  return digest.options.map(o => `- ${o.answer}: ${o.rationale}`).join('\n');
}

export function buildDefensePrompt(
  question: string,
  optionsBlock: string,
  ownAnswer: string,
): string {
  const own = ownAnswer.trim() || '(you did not provide an initial answer)';
  return `Original question:
"""
${question}
"""

${UNTRUSTED_PEER_CONTENT_NOTICE}

The council proposed these options (each with the reasoning offered for it):
${optionsBlock || '(no options were extracted)'}

Your initial answer was:
"""
${own}
"""

Defend your initial selection: argue why it is the strongest choice, and explain
specifically why each of the other options is NOT better. Be concrete and
critical, but fair — concede a genuine strength where one exists. Keep it focused.`;
}

// ─── Step 3: judge builds the pros/cons dossier ──────────────────────────────

export function buildDossierPrompt(
  question: string,
  digest: PooledDigest,
  initial: RawResponse[],
  defenses: RawResponse[],
): string {
  const optionList = digest.options.map(o => `- ${o.answer}`).join('\n');
  const initialBlock = initial
    .filter(r => !r.error && r.response.trim())
    .map(r => `### ${r.label}\n${r.response}`)
    .join('\n\n');
  const defenseBlock = defenses
    .filter(r => !r.error && r.response.trim())
    .map(r => `### ${r.label}\n${r.response}`)
    .join('\n\n');

  return `You are compiling a DIALECTICAL pros/cons analysis (thesis → antithesis → synthesis).

Question:
"""
${question}
"""

${UNTRUSTED_CONTENT_NOTICE}

The distinct options under debate:
${optionList || '(none)'}

[INITIAL ANSWERS — theses]
${initialBlock}

[DEFENSES & CRITIQUES — antitheses]
${defenseBlock}

For EACH option above, extract:
- "pros": the strongest arguments IN FAVOUR (from its proponents and defenders), merged and deduplicated.
- "cons": the strongest ADVERSE arguments (raised by members arguing a different option is better), merged and deduplicated.
Keep it balanced — where the texts support it, every option should carry both pros and cons. Use short, self-contained argument phrases.
Use each option's answer text EXACTLY as written in the list above — do not rephrase, expand, abbreviate, or reformat it.

Return ONLY valid JSON (no markdown):
{ "options": [ { "answer": "<option>", "pros": ["..."], "cons": ["..."] } ] }`;
}

interface RawDossierJSON {
  options?: unknown;
}

const DOSSIER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'object', properties: {
    answer: { type: 'string' }, pros: { type: 'array', items: { type: 'string' } }, cons: { type: 'array', items: { type: 'string' } },
  }, required: ['answer', 'pros', 'cons'] } } },
  required: ['options'],
};

function parseDossierJSON(raw: string): RawDossierJSON {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  // Tolerate a prose preamble/postamble around the JSON object (incl. trailing
  // prose containing braces — see sliceBalancedJson).
  return parseJudgeJson<RawDossierJSON>(raw, { options: 'array' });
}

/** Coerce an untrusted JSON value to a clean string[] (judge output is not to be trusted). */
function toStrList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map(s => (typeof s === 'string' ? s : String(s)).trim()).filter(Boolean);
}

const dedup = (xs: string[]): string[] => [...new Set(xs)];

const keyFor = (a: string): string => a.trim().toLowerCase();

/** Match a (possibly rephrased) judge answer back to a canonical digest option. */
export function matchOption(
  answer: string,
  byAnswer: Map<string, DialecticOption>,
): DialecticOption | undefined {
  const k = keyFor(answer);
  const exact = byAnswer.get(k);
  if (exact) return exact;
  // Fuzzy: one string contains the other (e.g. "Rust" ↔ "Rust (systems)"). When
  // more than one option matches — one option's text can be a substring of
  // another's, e.g. "Java" is a substring of "JavaScript" — prefer the LONGEST
  // matching key (the more specific option) instead of the first hit in Map
  // insertion order, which could otherwise merge a rephrased answer onto the
  // wrong canonical option (e.g. "JavaScript (Node)" wrongly matching "Java"
  // just because it was inserted first).
  let best: DialecticOption | undefined;
  let bestLen = -1;
  for (const opt of byAnswer.values()) {
    const ok = keyFor(opt.answer);
    const matches = (k.includes(ok) && ok.length >= 4) || (ok.includes(k) && k.length >= 4);
    if (matches && ok.length > bestLen) {
      best = opt;
      bestLen = ok.length;
    }
  }
  return best;
}

interface ProsConsResult {
  options: DialecticOption[];
  /** True when the dossier-building judge call itself failed/degraded (distinct from there simply being nothing to debate). */
  judgeDegraded: boolean;
}

async function buildProsCons(
  question: string,
  digest: PooledDigest,
  initial: RawResponse[],
  defenses: RawResponse[],
  judgeModelId: ModelId,
  judgeProvider: Provider,
  cc: CompleteConfig,
  runtime: RuntimeConfig,
): Promise<ProsConsResult> {
  // The pooled digest is the CANONICAL option set: seed one entry per distinct
  // option with its champions and a rationale-derived pro as a floor. The judge's
  // richer pros/cons merge onto these; a rephrased judge answer is matched back
  // (so championedBy is never lost and options don't duplicate).
  const byAnswer = new Map<string, DialecticOption>();
  for (const o of digest.options) {
    byAnswer.set(keyFor(o.answer), {
      answer: o.answer,
      pros: o.rationale ? [o.rationale] : [],
      cons: [],
      championedBy: o.models,
    });
  }

  // Ask the judge for the dossier only when there is something to debate.
  let parsed: RawDossierJSON = {};
  let judgeDegraded = false;
  if (digest.options.length > 0) {
    let rawJson = '';
    try {
      rawJson = await pooledComplete(
        { modelId: judgeModelId, provider: judgeProvider },
        [{ role: 'user', content: buildDossierPrompt(question, digest, initial, defenses) }],
        { jsonMode: true, jsonSchema: DOSSIER_SCHEMA, temperature: 0.2, maxTokens: cc.maxTokens, timeoutMs: cc.timeoutMs, effort: cc.effort },
        cc.retries,
        runtime,
      );
    } catch (err) {
      // Empty after retries → degrade to the digest-seeded sheet, flagged so a
      // caller can't mistake it for a genuine "nothing more to add" outcome.
      // A genuine provider error still propagates.
      if (err instanceof EmptyCompletionError) {
        judgeDegraded = true;
      } else {
        throw new Error(
          `Judge model (${modelIdLabel(judgeModelId)}) failed to build pros/cons: ${String(err)}`,
        );
      }
    }
    // Parse separately so malformed (non-empty) JSON ALSO degrades gracefully to
    // the digest-seeded sheet instead of failing the whole request.
    if (rawJson) {
      try {
        parsed = parseDossierJSON(rawJson);
      } catch {
        parsed = {};
        judgeDegraded = true;
      }
    }
  }

  // Merge the judge's pros/cons onto the canonical options (untrusted shape:
  // options may not be an array; pros/cons may not be string arrays).
  const options = Array.isArray(parsed.options) ? parsed.options : [];
  for (const raw of options) {
    const o = (raw ?? {}) as { answer?: unknown; pros?: unknown; cons?: unknown };
    const answer = typeof o.answer === 'string' ? o.answer.trim() : '';
    if (!answer) continue;
    const pros = toStrList(o.pros);
    const cons = toStrList(o.cons);
    const match = matchOption(answer, byAnswer);
    if (match) {
      if (pros.length) match.pros = dedup(pros);   // judge pros supersede the rationale floor
      if (cons.length) match.cons = dedup(cons);
    } else {
      byAnswer.set(keyFor(answer), { answer, pros, cons, championedBy: [] });
    }
  }

  return { options: [...byAnswer.values()], judgeDegraded };
}

// ─── Step 4 prompt: choose top 3 from the dialectic ──────────────────────────

export function buildSelectionPrompt(question: string, prosCons: DialecticOption[]): string {
  if (prosCons.length === 0) return question;

  const block = prosCons
    .map(o => {
      const pros = o.pros.length ? o.pros.join('; ') : '(none noted)';
      const cons = o.cons.length ? o.cons.join('; ') : '(none noted)';
      return `### ${o.answer}\nPros: ${pros}\nCons: ${cons}`;
    })
    .join('\n\n');

  return `Original question:
"""
${question}
"""

${UNTRUSTED_PEER_CONTENT_NOTICE}

Here is a balanced pros/cons analysis of each option, compiled from the council's
arguments for and against:

${block}

Weighing both sides of this dialectic, select your TOP 3 as a ranked list, each
with a one-line justification that reflects the trade-offs (acknowledge the main
"con" you are accepting). Start with #1.`;
}

// ─── Main dialectic entry point ──────────────────────────────────────────────

export interface DialecticInput {
  /** (Possibly augmented) question shown to MEMBERS in the defense/selection rounds. */
  question: string;
  /**
   * ORIGINAL question for the JUDGE prompts (digest + pros/cons dossier) — the
   * judge works from member TEXT and needs no attachments; the augmented
   * question here would embed untrusted content in a trust-affirming block.
   * Defaults to `question`.
   */
  judgeQuestion?: string;
  initialResponses: RawResponse[];
  members: Member[];
  judgeModelId: ModelId;
  judgeProvider: Provider;
  runtime: RuntimeConfig;
  /** When true, include the initial (thesis) responses in the result. */
  verbose: boolean;
  /**
   * Re-attached to the defense and selection rounds' member queries — a member
   * defending or re-selecting from a description of an image must still be
   * looking at it, not recalling its own round-0 description. Never sent to
   * the judge (buildDossierPrompt works from the members' text responses only).
   */
  images?: ChatImage[];
}

export async function runDialectic(input: DialecticInput): Promise<DialecticResult> {
  const {
    question,
    initialResponses,
    members,
    judgeModelId,
    judgeProvider,
    runtime,
    verbose,
    images,
  } = input;
  // Original question for judge prompts; augmented `question` for member rounds.
  const judgeQuestion = input.judgeQuestion ?? question;
  const cc: CompleteConfig = {
    maxTokens: runtime.maxTokens, retries: runtime.retries, timeoutMs: runtime.requestTimeoutMs,
    effort: runtime.reasoningEffort,
  };

  // 1. Distil the distinct options (reuse the pooled digest).
  const digest = await poolResponses(
    judgeQuestion,
    initialResponses,
    judgeModelId,
    judgeProvider,
    cc,
    runtime,
  );
  const optionsBlock = renderOptions(digest);

  // 2. Antithesis: each member defends its own pick and critiques the rest.
  //    initialResponses is in member order, so member[i] ↔ initialResponses[i].
  const defenses = await queryMembersVarying(
    (_member, i) => buildDefensePrompt(question, optionsBlock, initialResponses[i]?.response ?? ''),
    members,
    runtime,
    {},
    images,
  );

  // 3. Judge compiles the pros/cons dossier.
  const prosConsResult = await buildProsCons(
    judgeQuestion,
    digest,
    initialResponses,
    defenses,
    judgeModelId,
    judgeProvider,
    cc,
    runtime,
  );
  const prosCons = prosConsResult.options;

  // 4. Synthesis: each member selects a ranked top-3 from the dossier.
  const selections = await queryMembers(
    buildSelectionPrompt(question, prosCons),
    members,
    runtime,
    {},
    images,
  );

  // A partial outage in the DEFENSE round itself must also degrade the result.
  // buildProsCons filters errored defenses out of its judge prompt (so the
  // dossier is distilled over an incomplete antithesis) but never checks
  // `defenses` for errors, and its own judgeDegraded only covers judge-call/
  // parsing failure — neither path sees a member that simply didn't answer
  // this round. Without this, an incomplete defense round produces an
  // apparently-complete dossier with no degradation signal, mirroring the same
  // partial-outage gap categorize()/poolResponses() were fixed for.
  const defenseOutage = defenses.some(r => r.error);
  // The SELECTION round (step 4) is the dialectic's actual convergence output:
  // each member's final ranked pick after weighing the pros/cons. A member that
  // errors HERE is absent from `selections` — the council's final position is
  // incomplete — yet none of the three existing judgeDegraded sources see it
  // (digest covers the round-0 thesis, prosConsResult covers the judge dossier
  // call, defenseOutage covers step 2). Reproduced: 3 members, one errors in
  // the selection round → selections holds 2 picks + 1 error, judgeDegraded
  // stays undefined, and a caller trusting the top-level flag reads an
  // incomplete convergence as clean. Symmetric to defenseOutage; same class
  // of partial-outage gap. The top-level judgeDegraded is the uniform "don't
  // trust this as clean convergence" signal across every mode, so a selection-
  // round outage must elevate it just as a defense-round outage does.
  const selectionOutage = selections.some(r => r.error);
  const judgeDegraded =
    digest.judgeDegraded || prosConsResult.judgeDegraded || defenseOutage || selectionOutage;

  return {
    mode: 'dialectic',
    question,
    judgeModel: modelIdLabel(judgeModelId),
    defenses,
    prosCons,
    selections,
    ...(judgeDegraded ? { judgeDegraded: true } : {}),
    ...(verbose ? { initialResponses } : {}),
  };
}
