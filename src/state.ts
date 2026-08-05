/**
 * Server-owned persistent state (per machine), so the user's tier choices and
 * council edits survive restarts — the current in-memory config is wiped on
 * every plugin reload. Location: $MODEL_COUNCIL_STATE, else
 * $XDG_CONFIG_HOME/model-council/state.json, else ~/.config/model-council/state.json.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ModelId, ReasoningEffort, ResponseMode } from './types.js';
import type { HarnessCapability } from './harness.js';

export interface CouncilState {
  version: number;
  /** User-selected subscription tiers (override env/userConfig defaults). */
  tiers?: { chatgpt?: string; claude?: string; grok?: string; ollama?: string };
  /** Materialised council members (model-id labels) — makes deletions stick. */
  members?: string[];
  /**
   * configure_council settings persisted the same way `members` already is —
   * only present when a caller has explicitly set it at least once, and only
   * that field is ever rewritten (see configure_council's handler). Applied
   * at boot ahead of the env-derived JUDGE_MODEL/RESPONSE_MODE/
   * MAX_DECONFLICT_ROUNDS defaults, same precedence `tiers` already has.
   */
  judgeModelId?: ModelId;
  responseMode?: ResponseMode;
  maxDeconflictRounds?: number;
  autoCouncil?: boolean;
  /**
   * Per-completion timeouts (ms) set via set_council_timeouts, overriding the
   * REQUEST_TIMEOUT_MS / REPO_REQUEST_TIMEOUT_MS env+userConfig defaults the
   * same way `tiers` overrides boot defaults. `run` = text-only calls,
   * `repo` = calls with full_repo_access. Undefined = use the boot default.
   */
  timeouts?: { run?: number; repo?: number };
  /**
   * Council-wide reasoning depth set via configure_council, overriding the
   * REASONING_EFFORT env/userConfig default the same way `timeouts` overrides
   * the timeout defaults. Undefined = use the boot default (which is itself
   * usually unset, meaning each model's own default depth).
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Council-wide web access set via configure_council. Persisted like every
   * other configure_council setting, and deliberately NOT seeded on a first
   * run the way reasoningEffort is: research pulls untrusted text off the
   * internet into member answers, so it stays an explicit opt-in.
   */
  webAccess?: boolean;
  /**
   * Parallel tool executions inside one claude-cli member call, exported as
   * CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY on the spawn. Seeded whenever the
   * key is ABSENT (fresh install or upgrade from a pre-knob version) — see
   * SEED_HARNESS_TOOL_CONCURRENCY in index.ts — then edited only by the user.
   */
  harnessToolConcurrency?: number;
  /**
   * Root for member output files (configure_council `output_file_location`).
   * Absent = the OS tmpdir.
   */
  outputFileLocation?: string;
  /** Reference-data version the user was last welcomed for. */
  welcomedVersion?: string;
  /**
   * Resolved runtime paths, persisted so the SessionStart hook can read them —
   * the plugin host does NOT pass userConfig-derived env vars to hook processes.
   */
  env?: { ollamaAddress?: string; claudeCliPath?: string; codexCliPath?: string; grokCliPath?: string };
  /**
   * Verified vision-capability results, keyed by model-id label (e.g.
   * "ollama:gemma4:12b", "claude-cli:opus") — the same format as `members`.
   * Only ever holds DEFINITIVE results (never a transient/inconclusive one —
   * those are deliberately never cached at all, in-memory or on disk). Lets a
   * restart skip re-running the OCR-challenge detection round trip for a
   * model already proven (in)capable in a prior session — on a slow machine
   * that round trip can take many seconds per model, which adds up across a
   * multi-member council and would otherwise repeat on every reload.
   *
   * Each entry carries `checkedAt` so it can expire (see VISION_CACHE_TTL_MS)
   * — without a TTL a definitive "not vision-capable" result would be sticky
   * forever, surviving even a later Ollama pull or provider fix that actually
   * makes the model capable, until someone manually edited this file.
   */
  visionCapability?: Record<string, VisionCacheEntry>;
  /**
   * What we LEARNED about driving each model through a harness, keyed by
   * model-id label exactly like `visionCapability`. This is the half of the
   * capability matrix that can't ship: which harness actually worked here, and
   * whether that model's tool-calling is usable at all.
   *
   * It survives plugin updates for free — state.json lives in ~/.config,
   * outside the plugin directory — which is the whole point: a model probed
   * once should never be probed again just because the plugin was upgraded.
   * Entries carry `checkedAt` and expire (HARNESS_CACHE_TTL_MS) so a backend
   * upgrade that ADDS support isn't locked out by an old "no".
   */
  harnessCapability?: Record<string, HarnessCapability>;
}

export interface VisionCacheEntry {
  value: boolean;
  /** epoch ms this result was actually verified, not merely written. */
  checkedAt: number;
}

/** How long a cached vision-capability result is trusted before being re-probed. */
export const VISION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const STATE_VERSION = 1;

const clean = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const t = v.trim();
  return t && !t.includes('${') ? t : undefined;
};

export function statePath(): string {
  const override = clean(process.env.MODEL_COUNCIL_STATE);
  if (override) return override;
  const base = clean(process.env.XDG_CONFIG_HOME) ?? join(homedir(), '.config');
  return join(base, 'model-council', 'state.json');
}

/**
 * Does a state file already exist on disk?
 *
 * This is how a genuinely FIRST run is told apart from an existing install
 * that simply never set a particular field — `loadState()` returns the same
 * bare `{version}` object for both, so it cannot distinguish them. Must be
 * called BEFORE anything writes state (boot persists resolved CLI paths early,
 * which creates the file), or every run looks like an upgrade.
 */
export function stateFileExists(): boolean {
  try {
    return statSync(statePath()).isFile();
  } catch {
    return false;
  }
}

let quarantineSeq = 0;
function quarantineCorrupt(): void {
  try {
    const p = statePath();
    // pid+seq keep the name unique even for two quarantines in the same ms
    // (or in two processes racing the same corrupt file).
    const aside = `${p}.corrupt-${Date.now()}-${process.pid}-${quarantineSeq++}`;
    renameSync(p, aside);
    process.stderr.write(
      `[model-council] state.json was unreadable/corrupt — moved to ${aside} so your settings can be recovered; starting from defaults\n`,
    );
  } catch { /* a sibling already moved it, or it truly is absent */ }
}

export function loadState(): CouncilState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), 'utf8'));
    // typeof [] === 'object' too — without the Array.isArray check, a
    // corrupted/hand-edited state file containing a bare JSON array would
    // pass this guard and later get spread in saveState() ({...current,
    // ...patch}), turning into {'0': ..., '1': ..., ...} and silently
    // corrupting every persisted field (tiers, members, visionCapability).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CouncilState;
    }
    quarantineCorrupt(); // parsed but wrong shape — same treatment as unparseable
  } catch (err) {
    // ENOENT is the ordinary first-run case. Anything else means a file
    // EXISTS but cannot be used — and returning the bare default would let
    // the next saveState() rebuild state.json from nothing, silently erasing
    // every setting the user ever made. Move the evidence aside instead:
    // recoverable by hand, visible on disk and stderr, and multi-process safe
    // (first renamer wins; siblings get ENOENT and fall through).
    if ((err as { code?: string }).code !== 'ENOENT') quarantineCorrupt();
  }
  return { version: STATE_VERSION };
}

/**
 * Merge a patch into the persisted state and write it back atomically (temp
 * file + rename), so a concurrent reader in another process never observes a
 * half-written file. Best-effort — non-fatal if the location is unwritable.
 *
 * `patch` may be a plain object OR a mutator function `(current) => patch`.
 * Prefer the mutator form whenever the patch depends on existing state (e.g.
 * merging one new entry into an existing map) and the caller read that state
 * some time ago, possibly across an `await`. A plain object patch is computed
 * from whatever snapshot the caller took earlier; if the file changed since
 * then (a concurrent `saveState` from another in-process call), that patch
 * silently overwrites the newer value for any key it touches. The mutator
 * form reads a FRESH `loadState()` synchronously, right before this
 * synchronous read-modify-write completes — with no `await` in between, no
 * other JS code in this process can interleave, so the merge is race-free
 * for same-process callers. (A patch built from data that's inherently only
 * known at write time is unaffected either way and can keep using the plain
 * form.)
 */
export function saveState(
  patch: Partial<CouncilState> | ((current: CouncilState) => Partial<CouncilState>),
): CouncilState {
  const current = loadState();
  const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
  const next: CouncilState = { ...current, ...resolvedPatch, version: STATE_VERSION };
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    // 0600: this file persists the resolved Ollama address, which may embed
    // basic-auth credentials (kept RAW here deliberately — the SessionStart hook
    // must actually connect with it). Default umask left it world-readable.
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, p); // atomic within a filesystem
  } catch {
    /* best-effort */
  }
  return next;
}
