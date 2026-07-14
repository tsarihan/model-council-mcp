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
import { Provider } from '../providers/base.js';
import { modelIdLabel } from '../config.js';
import { CompleteConfig } from './categorizer.js';
import { completeWithRetry, EmptyCompletionError, Member, queryMembers } from './query.js';

// ─── Judge prompt: build the neutral pooled digest ───────────────────────────

function buildPoolPrompt(question: string, responses: RawResponse[]): string {
  const responseBlock = responses
    .filter(r => !r.error && r.response.trim())
    .map(r => `### ${r.label}\n${r.response}`)
    .join('\n\n');

  return `You are pooling answers from multiple AI models to the SAME question, Delphi-style.

Question:
"""
${question}
"""

Model responses (the labels are for your bookkeeping only):
${responseBlock}

Produce a NEUTRAL pooled digest of the DISTINCT answers. Rules:
- Identify each distinct option that appears across the responses. If the question asks for a list or ranking, treat every listed item as a separate option and IGNORE its rank/order.
- Merge duplicates: when several responses give the same option (the same city, language, state, tool, etc.), combine them into ONE entry whose rationale synthesises all the reasons offered for it.
- Each rationale must be neutral and self-contained. Do NOT state how many models chose an option, do NOT signal popularity, do NOT rank or order by preference.
- In "models", list the labels of the responses that included that option. This is for record-keeping only and will NOT be shown back to the members.

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

function parsePoolJSON(raw: string): RawPoolJSON {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();
  // Tolerate a prose preamble/postamble around the JSON object.
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const json = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  return JSON.parse(json) as RawPoolJSON;
}

/** Ask the judge to distil responses into a neutral, deduplicated digest. */
export async function poolResponses(
  question: string,
  responses: RawResponse[],
  judgeModelId: ModelId,
  judgeProvider: Provider,
  cc: CompleteConfig,
): Promise<PooledDigest> {
  const prompt = buildPoolPrompt(question, responses);

  let rawJson: string;
  try {
    rawJson = await completeWithRetry(
      judgeProvider,
      judgeModelId.model,
      [{ role: 'user', content: prompt }],
      { jsonMode: true, temperature: 0.2, maxTokens: cc.maxTokens },
      cc.retries,
    );
  } catch (err) {
    // Judge produced nothing usable → empty digest (re-poll falls back to the
    // bare question). A genuine provider error still propagates.
    if (err instanceof EmptyCompletionError) return { options: [] };
    throw new Error(
      `Judge model (${modelIdLabel(judgeModelId)}) failed to pool responses: ${String(err)}`,
    );
  }

  let parsed: RawPoolJSON;
  try {
    parsed = parsePoolJSON(rawJson);
  } catch {
    return { options: [] };
  }

  return {
    options: (parsed.options ?? [])
      .map(o => ({
        answer: (o.answer ?? '').trim(),
        rationale: (o.rationale ?? '').trim(),
        models: o.models ?? [],
      }))
      .filter(o => o.answer),
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

Below, in no particular order, are the distinct answers other council members proposed, each with the combined reasoning offered for it. They are NOT ranked, and nothing indicates how many members chose each option or who chose it:

${list}

Considering these perspectives on their merits, answer the ORIGINAL question again in your own judgment. Keep your original view or revise it as you see fit — do not favour any option merely because it appears above; there is no popularity or ordering implied here.`;
}

// ─── Main pooled entry point ─────────────────────────────────────────────────

export interface PooledInput {
  question: string;
  initialResponses: RawResponse[];
  members: Member[];
  judgeModelId: ModelId;
  judgeProvider: Provider;
  runtime: RuntimeConfig;
  /** When true, include the initial (round-0) raw responses in the result. */
  verbose: boolean;
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
  } = input;
  const cc: CompleteConfig = { maxTokens: runtime.maxTokens, retries: runtime.retries };

  // 1. Judge distils round-0 answers into a neutral pool.
  const initialPool = await poolResponses(
    question,
    initialResponses,
    judgeModelId,
    judgeProvider,
    cc,
  );

  // 2. Re-poll every member with the neutral digest (no attribution/counts/order).
  const repollPrompt = buildRepollPrompt(question, initialPool);
  const reconsidered = await queryMembers(repollPrompt, members, runtime);

  // 3. Judge distils the reconsidered answers into a second neutral pool.
  //    No winner is declared — the two pools let the caller see any movement.
  const finalPool = await poolResponses(
    question,
    reconsidered,
    judgeModelId,
    judgeProvider,
    cc,
  );

  return {
    mode: 'pooled',
    question,
    judgeModel: modelIdLabel(judgeModelId),
    initialPool,
    reconsidered,
    finalPool,
    ...(verbose ? { initialResponses } : {}),
  };
}
