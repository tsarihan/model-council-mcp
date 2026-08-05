/**
 * Pooled (Delphi-style) reconsideration mode.
 *
 * Motivation: the deconfliction loop shows members the *labelled* positions of
 * every faction ("[modelA, modelB]: X") and asks them to "agree with one of the
 * existing positions." That is social proof — minority views collapse toward the
 * visible plurality in a single round, destroying the very decorrelation the
 * council exists to surface.
 *
 * The pooled mode removes the influence cues. The judge distils all answers into
 * a NEUTRAL digest: one entry per distinct answer (city, language, state,
 * whatever the question is about), with the reasoning merged from everyone who
 * offered it — but with NO counts, NO attribution, and NO ranking. Members are
 * then re-asked the ORIGINAL question with that digest, "in no particular order,"
 * and invited to answer freshly. No final winner is declared; the result reports
 * the neutral pool before and after reconsideration so movement is observable.
 */
import { ModelId, PooledDigest, PooledResult, RawResponse, RuntimeConfig } from '../types.js';
import { ChatImage, Provider, parseJudgeJson } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { CompleteConfig } from './categorizer.js';
import { EmptyCompletionError, Member, pooledComplete, queryMembers, withPhase } from './query.js';
import { UNTRUSTED_CONTENT_NOTICE, UNTRUSTED_PEER_CONTENT_NOTICE } from './prompt-safety.js';

// ─── Judge prompt: build the neutral pooled digest ───────────────────────────

export function buildPoolPrompt(question: string, responses: RawResponse[]): string {
  const responseBlock = responses
    .filter(r => !r.error && r.response.trim())
    .map(r => `### ${r.label}\n${r.response}`)
    .join('\n\n');

  return `You are pooling answers from multiple AI models to the SAME question, Delphi-style.

Question:
"""
${question}
"""

${UNTRUSTED_CONTENT_NOTICE}

Model responses (the labels are for your bookkeeping only):
${responseBlock}

Produce a NEUTRAL pooled digest of the DISTINCT answers. Rules:
- Identify each distinct option that appears across the responses. If the question asks for a list or ranking, treat every listed item as a separate option and IGNORE its rank/order.
- Merge duplicates: when several responses give the same option (the same city, language, state, tool, etc.), combine them into ONE entry whose rationale synthesises all the reasons offered for it.
- Each rationale must be neutral and self-contained. Do NOT state how many models chose an option, do NOT signal popularity, do NOT rank or order by preference.
- In "models", list ONLY the labels of responses that actually CHOSE or recommended that option as their answer (or ranked it first). A response that merely mentioned it, listed it among alternatives, or argued against it does NOT belong in "models" — attribution means advocacy, not mention. A response that declined to pick belongs in no option's "models" at all. This is for record-keeping only and will NOT be shown back to the members.

Return ONLY valid JSON (no markdown), with this schema:
{
  "options": [
    { "answer": "<concise option, e.g. 'Sarasota, FL' or 'Rust'>", "rationale": "<merged neutral reasoning>", "models": ["<label>", ...] }
  ]
}`;
}

interface RawPoolJSON {
  options?: Array<{ answer?: string; rationale?: string; models?: string[] }>;
}

const POOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'object', properties: {
    answer: { type: 'string' }, rationale: { type: 'string' }, models: { type: 'array', items: { type: 'string' } },
  }, required: ['answer', 'rationale', 'models'] } } },
  required: ['options'],
};

function parsePoolJSON(raw: string): RawPoolJSON {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  // Tolerate a prose preamble/postamble around the JSON object (incl. trailing
  // prose that itself contains braces — sliceBalancedJson matches the first
  // object's BALANCED close, not the last brace in the whole string).
  return parseJudgeJson<RawPoolJSON>(raw, { options: 'array' });
}

/** Ask the judge to distil responses into a neutral, deduplicated digest. */
export async function poolResponses(
  question: string,
  responses: RawResponse[],
  judgeModelId: ModelId,
  judgeProvider: Provider,
  cc: CompleteConfig,
  runtime: RuntimeConfig,
): Promise<PooledDigest> {
  // No member actually answered (every response errored, or none were
  // queried) — nothing genuine to pool. Skip the judge call and flag it like
  // a judge failure, same as categorize()'s identical guard: an empty digest
  // from an empty input would otherwise read as "nothing distinct to pool"
  // rather than "no data existed to pool in the first place."
  if (responses.length === 0 || responses.every(r => r.error)) {
    return { options: [], judgeDegraded: true };
  }

  // PARTIAL outage: buildPoolPrompt filters errored responses out, so the digest
  // is distilled over an INCOMPLETE council and the missing members are exactly
  // the ones that might have offered a distinct option. A pool that looks
  // unanimous may simply be missing its dissenters — the same
  // fabricated-convergence class the all-errored guard above prevents, and the
  // same flag categorize() now sets for its partial case.
  const partialOutage = responses.some(r => r.error);

  const prompt = buildPoolPrompt(question, responses);

  let rawJson: string;
  try {
    rawJson = await pooledComplete(
      { modelId: judgeModelId, provider: judgeProvider },
      [{ role: 'user', content: prompt }],
      { jsonMode: true, jsonSchema: POOL_SCHEMA, temperature: 0.2, maxTokens: cc.maxTokens, timeoutMs: cc.timeoutMs, effort: cc.effort },
      cc.retries,
      runtime,
    );
  } catch (err) {
    // Judge produced nothing usable → empty digest (re-poll falls back to the
    // bare question), flagged so a caller can't mistake this for a genuine
    // "nothing distinct to pool" result. A genuine provider error still propagates.
    if (err instanceof EmptyCompletionError) return { options: [], judgeDegraded: true };
    throw new Error(
      `Judge model (${modelIdLabel(judgeModelId)}) failed to pool responses: ${String(err)}`,
    );
  }

  let parsed: RawPoolJSON;
  try {
    parsed = parsePoolJSON(rawJson);
  } catch {
    return { options: [], judgeDegraded: true };
  }

  // Untrusted shape: `options` may not be an array (jsonMode only guarantees
  // parseable JSON). Guard with Array.isArray so a bare object can't crash pooled
  // and dialectic modes. (dialectic.ts already guards its own dossier the same way.)
  return {
    options: (Array.isArray(parsed.options) ? parsed.options : [])
      .map(o => ({
        answer: String(o?.answer ?? '').trim(),
        rationale: String(o?.rationale ?? '').trim(),
        models: Array.isArray(o?.models) ? o.models : [],
      }))
      .filter(o => o.answer),
    ...(partialOutage ? { judgeDegraded: true } : {}),
  };
}

// ─── Member-facing re-poll prompt (neutral, no attribution/counts/order) ─────

/** In-place-safe Fisher–Yates shuffle so the rendered order carries no signal. */
function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The digest as shown to members: answer + merged rationale only, shuffled,
 * with an explicit "no particular order" framing. Crucially it NEVER includes
 * the `models` attribution or any count — that is what keeps it uninfluenced.
 */
export function buildRepollPrompt(question: string, digest: PooledDigest): string {
  if (digest.options.length === 0) {
    // Nothing to show — just re-ask the original question.
    return question;
  }

  const list = shuffled(digest.options)
    .map(o => `- ${o.answer}: ${o.rationale}`)
    .join('\n');

  return `Original question:
"""
${question}
"""

${UNTRUSTED_PEER_CONTENT_NOTICE}

Below, in no particular order, are the distinct answers other council members proposed, each with the combined reasoning offered for it. They are NOT ranked, and nothing indicates how many members chose each option or who chose it:

${list}

Considering these perspectives on their merits, answer the ORIGINAL question again in your own judgment. Keep your original view or revise it as you see fit — do not favour any option merely because it appears above; there is no popularity or ordering implied here.`;
}

// ─── Main pooled entry point ─────────────────────────────────────────────────

export interface PooledInput {
  /** (Possibly augmented) question shown to MEMBERS in the re-poll. */
  question: string;
  /**
   * ORIGINAL question for the JUDGE pool-digest prompts — the judge distils
   * member TEXT and needs no attachments; the augmented question here would
   * embed untrusted content in a trust-affirming block. Defaults to `question`.
   */
  judgeQuestion?: string;
  initialResponses: RawResponse[];
  members: Member[];
  judgeModelId: ModelId;
  judgeProvider: Provider;
  runtime: RuntimeConfig;
  /** When true, include the initial (round-0) raw responses in the result. */
  verbose: boolean;
  /**
   * Re-attached to the reconsideration round's member queries — a member
   * "revising its view of an image" must see the image again, not work from
   * its own round-0 description of it. Never sent to the judge (poolResponses
   * works from the members' text responses only).
   */
  images?: ChatImage[];
}

export async function runPooled(input: PooledInput): Promise<PooledResult> {
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
  // Original question for the judge digests; augmented `question` for the re-poll.
  const judgeQuestion = input.judgeQuestion ?? question;
  const cc: CompleteConfig = {
    maxTokens: runtime.maxTokens, retries: runtime.retries, timeoutMs: runtime.requestTimeoutMs,
    effort: runtime.reasoningEffort,
  };

  // 1. Judge distils round-0 answers into a neutral pool.
  const initialPool = await poolResponses(
    judgeQuestion,
    initialResponses,
    judgeModelId,
    judgeProvider,
    cc,
    runtime,
  );

  // 2. Re-poll every member with the neutral digest (no attribution/counts/order).
  const repollPrompt = buildRepollPrompt(question, initialPool);
  const reconsidered = withPhase(
    await queryMembers(repollPrompt, members, runtime, {}, images),
    'reconsidered',
  );

  // 3. Judge distils the reconsidered answers into a second neutral pool.
  //    No winner is declared — the two pools let the caller see any movement.
  const finalPool = await poolResponses(
    judgeQuestion,
    reconsidered,
    judgeModelId,
    judgeProvider,
    cc,
    runtime,
  );

  return {
    mode: 'pooled',
    question,
    judgeModel: modelIdLabel(judgeModelId),
    initialPool,
    reconsidered,
    finalPool,
    // Aggregate both digests' degradation to the top level (see PooledResult).
    ...(initialPool.judgeDegraded || finalPool.judgeDegraded ? { judgeDegraded: true } : {}),
    ...(verbose ? { initialResponses } : {}),
  };
}
