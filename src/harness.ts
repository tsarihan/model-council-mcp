/**
 * Harness selection: which agentic CLI (if any) can drive a given member, and
 * what we have learned about that on THIS machine.
 *
 * The council's job is to get an answer, not to refuse one because we lack
 * built-in knowledge of a backend. So this module never says "unsupported" on a
 * guess — it says "not tried yet", and the caller probes.
 *
 * THE RULE: always prefer the claude-cli harness; use codex-cli only because an
 * engine cannot speak the Anthropic Messages API, never as a preference. That
 * collapses the whole matrix to one question per endpoint — does it serve
 * /v1/messages? — which is also exactly what the probe asks of anything the
 * shipped matrix doesn't already name.
 *
 * Two sources of truth, mirroring how this repo already splits reference data
 * from measured data:
 *   - SHIPPED  (config/harness-capabilities.json, like subscriptions.json):
 *     what is already known, so we don't pay to re-discover it.
 *   - LEARNED  (state.json `harnessCapability`, like `visionCapability`):
 *     what we probed here, kept across restarts AND plugin updates because
 *     state.json lives in ~/.config, outside the plugin directory.
 * Learned wins for a model the matrix doesn't name; the matrix wins when it
 * names one explicitly, since a shipped correction can be pulled but a stale
 * probe cannot correct itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderType } from './types.js';

/** Which CLI can drive a member. `none` = no tool loop; still answers, flattened. */
export type HarnessKind = 'claude-cli' | 'codex-cli' | 'none';

/**
 * What we know about a model, independent of what we know about its ENGINE.
 * `chat` and `tools` are separate on purpose: a model can answer perfectly and
 * still be useless for web research, because the harness executes only the
 * tool-call dialect it can parse (verified live — see toolDialectRisk).
 */
export interface HarnessCapability {
  harness: HarnessKind;
  /** Did an ordinary completion come back through that harness? */
  chat: boolean;
  /**
   * 'ok'          — a real tool call executed.
   * 'leaks'       — the model emitted its own tool-call markup as plain text,
   *                 so no tool ran (kimi-k3 does this; see claude-cli.ts).
   * 'unsupported' — the harness refused/never offered tools.
   * 'untested'    — no tool probe has run yet.
   */
  tools: 'ok' | 'leaks' | 'unsupported' | 'untested';
  /** epoch ms this was actually measured, not merely written (mirrors VisionCacheEntry). */
  checkedAt: number;
  /** Short human reason, so `council_status` can explain a routing decision. */
  note?: string;
  /**
   * Slowest SUCCESSFUL round observed for this model, in ms.
   *
   * Throughput across a mixed council spans ~20x — a local model on this
   * hardware runs around 10 tok/s, Ollama cloud around 200, the hosted APIs
   * 20-50 — so one fixed per-completion timeout is wrong by construction: it
   * is either far too generous for the fast members or a guillotine for the
   * slow ones. And the workloads that matter most (repo review, long
   * documents, long web pages) are exactly the ones that multiply output
   * length, so the spread widens precisely when it hurts.
   *
   * Rather than ask the user to tune per model, remember what each one has
   * actually needed and never cut it off below that. Only successes are
   * recorded, so a timeout can never inflate its own future budget.
   */
  slowestOkMs?: number;
}

/** How long a learned result is trusted — a backend upgrade can change the answer. */
export const HARNESS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface ProviderEntry {
  /** true / false / null — null means UNCONFIRMED, so it is probed, not assumed absent. */
  anthropicMessages: boolean | null;
  /**
   * Serves the OpenAI RESPONSES API — which is what the codex harness now
   * requires. Verified live against codex 0.144.6: `wire_api = "chat"` is
   * rejected at config load ("no longer supported"), so an engine that offers
   * only /v1/chat/completions CANNOT be driven through codex, however
   * OpenAI-compatible it otherwise is. Ollama is exactly that case — and needs
   * no fallback, since it speaks Anthropic Messages natively.
   */
  openaiResponses: boolean | null;
  harness: HarnessKind;
  needsApiKeyEnv?: string;
  evidence?: string;
}

interface CapabilityFile {
  version: number;
  providers: Record<string, ProviderEntry>;
  modelNotes?: { toolDialectRisk?: { match: string; risk: string }[] };
}

const FALLBACK: CapabilityFile = { version: 1, providers: {} };

/** Module directory: __dirname in the CJS bundle, import.meta.url under ESM/tsx. */
function moduleDir(): string {
  try {
    if (typeof __dirname === 'string') return __dirname;
  } catch { /* ESM */ }
  return dirname(fileURLToPath(import.meta.url));
}

let cached: CapabilityFile | null = null;

export function loadHarnessCapabilities(): CapabilityFile {
  if (cached) return cached;
  const dir = moduleDir();
  for (const p of [
    join(dir, 'harness-capabilities.json'),          // bundled / dist
    join(dir, '..', 'config', 'harness-capabilities.json'),
    join(dir, '..', '..', 'config', 'harness-capabilities.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as CapabilityFile;
      if (parsed && typeof parsed === 'object' && parsed.providers) {
        cached = parsed;
        return cached;
      }
    } catch { /* try the next location */ }
  }
  // Missing/corrupt reference data must not disable harnessing — with no
  // seeded knowledge every endpoint simply becomes "probe it", which is the
  // same path an unknown provider already takes.
  cached = FALLBACK;
  return cached;
}

/**
 * The harness to TRY FIRST for an engine, from shipped knowledge alone.
 *
 * `null` for anthropicMessages means unconfirmed — and unconfirmed still tries
 * claude-cli first, because the rule is "prefer claude unless the engine can't
 * speak Anthropic", and "we haven't checked" is not "it can't".
 */
export function seededHarness(provider: ProviderType): HarnessKind {
  const entry = loadHarnessCapabilities().providers[provider];
  if (!entry) return 'claude-cli';           // unknown engine → try the preferred one
  if (entry.anthropicMessages !== false) return 'claude-cli';
  return entry.openaiResponses !== false ? 'codex-cli' : 'none';
}

/** The ordered list to try, so a failed first choice falls through instead of giving up. */
export function harnessLadder(provider: ProviderType): HarnessKind[] {
  const first = seededHarness(provider);
  const entry = loadHarnessCapabilities().providers[provider];
  const ladder: HarnessKind[] = [first];
  if (first === 'claude-cli' && (entry?.openaiResponses ?? true) !== false) ladder.push('codex-cli');
  return ladder;
}

/** API-key env var an engine needs when driven through a harness, if any. */
export function harnessApiKeyEnv(provider: ProviderType): string | undefined {
  return loadHarnessCapabilities().providers[provider]?.needsApiKeyEnv;
}

/**
 * A known tool-call-dialect caveat for this model name, or undefined.
 * Advisory only — it decides nothing. It exists so a probe result that says
 * `tools: 'leaks'` can be explained to the user rather than looking arbitrary,
 * and so `council_status` can warn before a web run rather than after.
 */
export function toolDialectRisk(model: string): string | undefined {
  const risks = loadHarnessCapabilities().modelNotes?.toolDialectRisk ?? [];
  const bare = model.toLowerCase();
  for (const r of risks) {
    try {
      if (new RegExp(r.match, 'i').test(bare)) return r.risk;
    } catch { /* a bad pattern in editable reference data must not throw */ }
  }
  return undefined;
}

/** Is a learned entry still trustworthy, or has it aged out? */
export function isFresh(entry: HarnessCapability | undefined, now: number): entry is HarnessCapability {
  return (
    !!entry &&
    typeof entry.checkedAt === 'number' &&
    Number.isFinite(entry.checkedAt) &&
    now - entry.checkedAt < HARNESS_CACHE_TTL_MS
  );
}
