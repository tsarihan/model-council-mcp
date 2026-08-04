/**
 * Server-owned persistent state (per machine), so the user's tier choices and
 * council edits survive restarts — the current in-memory config is wiped on
 * every plugin reload. Location: $MODEL_COUNCIL_STATE, else
 * $XDG_CONFIG_HOME/model-council/state.json, else ~/.config/model-council/state.json.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ModelId, ReasoningEffort, ResponseMode } from './types.js';

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
  } catch {
    /* no state file yet */
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
