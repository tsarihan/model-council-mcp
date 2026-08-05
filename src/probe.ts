/**
 * Live harness probing: find out what a member can ACTUALLY do, once, and
 * remember it.
 *
 * The shipped matrix (harness.ts) says what to try; this decides what works.
 * The council's job is to get an answer, so an engine we know nothing about is
 * tried rather than refused — and a result, positive or negative, is written to
 * `state.json harnessCapability` so the cost is paid at most once per model per
 * TTL, across restarts AND plugin updates.
 *
 * Two facts are measured separately because they fail independently:
 *   - `chat`  — does an ordinary completion come back through this harness?
 *   - `tools` — does a TOOL CALL actually execute? A model can answer perfectly
 *     and still be useless for research, because the harness executes only the
 *     tool-call dialect it can parse. Verified live: kimi-k3:cloud answers fine
 *     but can emit its own `<|open|>tools` markup as plain text, so no search
 *     runs (claude-cli.ts rejects that reply; here we remember WHY).
 *
 * Cost control: the tool probe is the expensive one (a real search), so it runs
 * only when the caller actually wants web access, and never for a model whose
 * chat probe already failed.
 */
import { ModelId, ProviderType } from './types.js';
import { isTimeoutError } from './providers/base.js';
import { ProviderRegistry } from './providers/registry.js';
import { modelIdLabel } from './config.js';
import { loadState, saveState } from './state.js';
import {
  HarnessCapability,
  HarnessKind,
  harnessLadder,
  isFresh,
  toolDialectRisk,
} from './harness.js';

/** Kept tight: a probe must never cost what a real member round costs. */
const PROBE_TIMEOUT_MS = 45_000;
/**
 * Fallback tool-probe budget when the caller passes none. The probe performs
 * exactly the work a real round performs — the model decides to call a tool,
 * the CLI runs a live search, the model reads results and answers — so callers
 * should hand it the SAME allowance a real round gets (`requestTimeoutMs`);
 * anything less turns "slow" into "incapable". Measured live: 45s branded a
 * capable model unsupported, and one cloud model took 400s to research a single
 * question, so even a generous fixed constant is the wrong shape here.
 */
const TOOL_PROBE_TIMEOUT_MS = 180_000;
const PROBE_MAX_TOKENS = 256;
const CHAT_PROBE = 'Reply with exactly: READY';
/**
 * A question that CANNOT be answered from training data, so a confident-looking
 * answer without a search is still a failure we can detect. The model is told
 * to say NOSEARCH when it has no tool — that is the honest negative we want,
 * rather than a hallucinated date.
 */
const TOOL_PROBE =
  'Use your web search tool to find the current top headline on example.com or any news site. ' +
  'If you have no working web search tool, reply with exactly: NOSEARCH';

/** Raw tool-call markup leaking into text means the loop never executed. */
const LEAKED_MARKUP = /<\|open\|>\s*tools?\b|<\|call\b|<\|tool_call\b|"tool_call"\s*:/i;

/**
 * The harness server id registered for an engine (see config.ts). Kept here
 * next to the probe so the routing and the probing can never disagree about
 * which server they mean.
 */
export function harnessServerId(provider: ProviderType, serverId: string | undefined, kind: HarnessKind): string {
  if (provider === 'ollama' && kind === 'claude-cli') return 'claude-cli-ollama';
  return `${kind}-${serverId ?? provider}`;
}

/** The routed ModelId for a member on a given harness, or null if unregistered. */
export function routedId(id: ModelId, kind: HarnessKind, registry: ProviderRegistry): ModelId | null {
  if (kind === 'none') return null;
  const routed: ModelId = {
    provider: kind,
    serverId: harnessServerId(id.provider, id.serverId, kind),
    model: id.model,
  };
  return registry.resolve(routed) ? routed : null;
}

function readMemory(label: string): HarnessCapability | undefined {
  return loadState().harnessCapability?.[label];
}

/**
 * Merge one entry into the learned map. Uses saveState's MUTATOR form because
 * the patch depends on existing state read across an await — the plain-object
 * form would clobber a concurrently-probed sibling member's entry.
 */
function remember(label: string, entry: HarnessCapability): void {
  saveState(current => ({
    harnessCapability: { ...(current.harnessCapability ?? {}), [label]: entry },
  }));
}

export interface ProbeOptions {
  /** Also probe TOOL calling, not just chat. Costs a real search — only when needed. */
  wantTools: boolean;
  /** Skip the memory and re-measure (used by an explicit "re-detect" path). */
  force?: boolean;
  /**
   * Budget for the TOOL probe — pass the same `requestTimeoutMs` a real round
   * gets. A probe held to a tighter deadline than the work it is imitating can
   * only ever produce a false negative on a slow model.
   */
  toolTimeoutMs?: number;
}

/**
 * Determine — and persist — how a member can be driven.
 *
 * Returns the capability actually established. A member with no working
 * harness still gets an entry (`harness: 'none'`), because "we tried and it
 * did not work" is worth remembering just as much as a success; without it
 * every ask would re-probe the same dead endpoint.
 */
export async function probeHarness(
  id: ModelId,
  registry: ProviderRegistry,
  opts: ProbeOptions,
): Promise<HarnessCapability> {
  const label = modelIdLabel(id);
  const now = Date.now();

  const cached = readMemory(label);
  // A cached entry is reusable only if it answers the question being asked:
  // one that never probed tools cannot settle a web-access run.
  if (!opts.force && isFresh(cached, now) && !(opts.wantTools && cached.tools === 'untested')) {
    return cached;
  }

  for (const kind of harnessLadder(id.provider)) {
    const routed = routedId(id, kind, registry);
    if (!routed) continue;
    const provider = registry.resolve(routed);
    if (!provider) continue;

    // ── 1. Chat: can this harness drive the model at all? ──────────────────
    let chatOk = false;
    try {
      const out = await provider.complete(
        routed.model,
        [{ role: 'user', content: CHAT_PROBE }],
        { maxTokens: PROBE_MAX_TOKENS, timeoutMs: PROBE_TIMEOUT_MS },
      );
      chatOk = !!out && out.trim() !== '';
    } catch {
      chatOk = false; // try the next rung rather than giving up on the member
    }
    if (!chatOk) continue;

    if (!opts.wantTools) {
      const entry: HarnessCapability = { harness: kind, chat: true, tools: 'untested', checkedAt: now };
      remember(label, entry);
      return entry;
    }

    // ── 2. Tools: does a tool call actually EXECUTE? ───────────────────────
    let tools: HarnessCapability['tools'] = 'unsupported';
    let note = toolDialectRisk(routed.model);
    try {
      const out = await provider.complete(
        routed.model,
        [{ role: 'user', content: TOOL_PROBE }],
        { maxTokens: PROBE_MAX_TOKENS, timeoutMs: opts.toolTimeoutMs ?? TOOL_PROBE_TIMEOUT_MS, webSearch: true },
      );
      const text = (out ?? '').trim();
      if (LEAKED_MARKUP.test(text)) {
        tools = 'leaks';
        note = note ?? 'emitted raw tool-call markup as text; the harness never executed a call';
      } else if (/\bNOSEARCH\b/i.test(text)) {
        tools = 'unsupported';
        note = note ?? 'model reported it had no working web search tool';
      } else if (text) {
        tools = 'ok';
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (LEAKED_MARKUP.test(msg) || /tool-call markup/i.test(msg)) {
        // The provider's own leak guard threw — a DEFINITIVE result worth
        // remembering, not an error to retry forever.
        tools = 'leaks';
        note = note ?? 'emitted raw tool-call markup as text; the harness never executed a call';
      } else if (isTimeoutError(err)) {
        // TRANSIENT. Measured live: a 45s tool probe against a local model
        // timed out and was written down as "tools: unsupported" — condemning
        // a capable model on a slow machine, permanently, from one slow run.
        // The vision cache already refuses to cache inconclusive probes for
        // exactly this reason; do the same here. 'untested' means the next ask
        // re-probes rather than trusting a verdict we never actually reached.
        tools = 'untested';
        note = 'tool probe timed out — inconclusive, will re-probe';
      } else {
        tools = 'unsupported';
        note = note ?? msg.slice(0, 160);
      }
    }

    const entry: HarnessCapability = {
      harness: kind, chat: true, tools, checkedAt: now, ...(note ? { note } : {}),
    };
    remember(label, entry);
    // A harness that drives chat but cannot execute tools is still the best
    // route for ordinary asks, so stop here rather than burning the next rung:
    // the recorded `tools` value is what tells the caller not to promise research.
    return entry;
  }

  // Nothing drove it. Recorded so the next ask doesn't repeat the attempt —
  // the member still answers, via its own provider's flattened completion.
  const entry: HarnessCapability = {
    harness: 'none',
    chat: false,
    tools: 'unsupported',
    checkedAt: now,
    note: 'no registered harness could drive this model; it answers via a single completion',
  };
  remember(label, entry);
  return entry;
}

/**
 * Record a capability learned from a REAL council round rather than a probe.
 *
 * A member that just researched successfully has demonstrated everything a
 * probe would have measured — the harness drove it, and a tool call executed —
 * so paying for a separate probe to learn the same fact is waste. It also
 * settles the one case a probe cannot: a model slower than any sane probe
 * budget (one took 400s live) would time out forever and never earn a cached
 * verdict, yet answers perfectly well when given a real round's allowance.
 *
 * Deliberately only ever writes a POSITIVE result. A member that errored in a
 * round failed for reasons a round cannot distinguish — quota, a timeout, a bad
 * prompt — and turning that into "this model cannot use tools" is exactly the
 * false-verdict trap the timeout fix removed.
 */
export function rememberRoundSuccess(
  originalId: ModelId,
  harness: HarnessKind,
  toolsProven: boolean,
  latencyMs?: number,
  /** Was this a heavy round (full_repo_access / web_access)? */
  heavy = false,
): void {
  const label = modelIdLabel(originalId);
  const prior = readMemory(label);
  // Never downgrade a stronger fact: a prior 'ok' stays 'ok' even if this
  // round only proved chat.
  const tools: HarnessCapability['tools'] =
    toolsProven || prior?.tools === 'ok' ? 'ok' : (prior?.tools ?? 'untested');

  // Write ONLY when this round actually establishes something new. Rewriting
  // an unchanged entry every round would churn state.json on every ask and,
  // worse, keep resetting `checkedAt` — turning it from "when this fact was
  // established" into "when we last happened to ask", which is not a
  // measurement and would let a stale fact live forever by being re-touched.
  // An entry that expires while still true costs nothing: the next round
  // re-establishes it here, for free.
  // Keep the slowest success ever seen — that is the number that must not be
  // undercut next time. It only ever grows from a SUCCESS, so a timeout can
  // never inflate the budget that caused it.
  const priorPlain = prior?.slowestOkMs ?? 0;
  const priorHeavy = prior?.slowestOkHeavyMs ?? 0;
  const slowestOkMs = (heavy ? priorPlain : Math.max(priorPlain, latencyMs ?? 0)) || undefined;
  const slowestOkHeavyMs = (heavy ? Math.max(priorHeavy, latencyMs ?? 0) : priorHeavy) || undefined;
  const slowerThanKnown =
    (slowestOkMs ?? 0) > priorPlain || (slowestOkHeavyMs ?? 0) > priorHeavy;

  if (
    !slowerThanKnown &&
    isFresh(prior, Date.now()) && prior.harness === harness && prior.tools === tools
  ) return;

  remember(label, {
    harness, chat: true, tools,
    // Preserve the ESTABLISHMENT time when all we learned is that the model
    // can be slower than we had seen. `checkedAt` answers "when was this
    // capability measured", and refining a latency figure does not re-measure
    // the capability — bumping it there would quietly extend the TTL of a
    // fact whose evidence is unchanged, and make "did we re-probe?" impossible
    // to answer from the record.
    checkedAt: prior && isFresh(prior, Date.now()) && prior.harness === harness && prior.tools === tools
      ? prior.checkedAt
      : Date.now(),
    ...(slowestOkMs ? { slowestOkMs } : {}),
    ...(slowestOkHeavyMs ? { slowestOkHeavyMs } : {}),
  });
}

/**
 * Per-member timeout floor learned from history: a member that has genuinely
 * needed N ms before is given at least that again, with headroom. Returns
 * undefined when nothing has been measured, so the configured timeout stands.
 *
 * Capped so one pathological run cannot grant a member an unbounded lease on
 * the whole council's wall-clock.
 */
export const LEARNED_TIMEOUT_HEADROOM = 1.5;
export const LEARNED_TIMEOUT_CEILING_MS = 30 * 60 * 1000;

export function learnedTimeoutFloorMs(id: ModelId, heavy = false): number | undefined {
  const entry = readMemory(modelIdLabel(id));
  if (!entry) return undefined;
  // Heavy work is a superset of plain work, so a plain measurement is a valid
  // LOWER BOUND for a heavy call and is used as one — a model already known to
  // need 400s to answer a question will not review a repo in less. The reverse
  // is not evidence: a long repo review says nothing about a short question,
  // so a heavy figure never inflates the plain floor.
  const observed = heavy
    ? Math.max(entry.slowestOkHeavyMs ?? 0, entry.slowestOkMs ?? 0)
    : (entry.slowestOkMs ?? 0);
  if (!observed) return undefined;
  return Math.min(Math.round(observed * LEARNED_TIMEOUT_HEADROOM), LEARNED_TIMEOUT_CEILING_MS);
}

/**
 * The harness to use RIGHT NOW without paying for a probe: a fresh learned
 * result if we have one, else null meaning "not known yet — probe or use the
 * seeded ladder". Kept separate from probeHarness so the hot path never
 * accidentally performs I/O-bound detection.
 */
export function rememberedHarness(id: ModelId): HarnessCapability | null {
  const entry = readMemory(modelIdLabel(id));
  return isFresh(entry, Date.now()) ? entry : null;
}
