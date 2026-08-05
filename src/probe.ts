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
 * The TOOL probe gets a much bigger budget than the chat probe. It is a real
 * agentic round trip — the model decides to call a tool, the CLI executes a
 * live web search, the model then reads results and answers — and 45s was
 * measured to be too short for that on a local model, which recorded a
 * TIMEOUT as a permanent "tools: unsupported". Slow is not incapable.
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
        { maxTokens: PROBE_MAX_TOKENS, timeoutMs: TOOL_PROBE_TIMEOUT_MS, webSearch: true },
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
 * The harness to use RIGHT NOW without paying for a probe: a fresh learned
 * result if we have one, else null meaning "not known yet — probe or use the
 * seeded ladder". Kept separate from probeHarness so the hot path never
 * accidentally performs I/O-bound detection.
 */
export function rememberedHarness(id: ModelId): HarnessCapability | null {
  const entry = readMemory(modelIdLabel(id));
  return isFresh(entry, Date.now()) ? entry : null;
}
