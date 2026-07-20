/**
 * Server-owned persistent state (per machine), so the user's tier choices and
 * council edits survive restarts — the current in-memory config is wiped on
 * every plugin reload. Location: $MODEL_COUNCIL_STATE, else
 * $XDG_CONFIG_HOME/model-council/state.json, else ~/.config/model-council/state.json.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface CouncilState {
  version: number;
  /** User-selected subscription tiers (override env/userConfig defaults). */
  tiers?: { chatgpt?: string; claude?: string; ollama?: string };
  /** Materialised council members (model-id labels) — makes deletions stick. */
  members?: string[];
  /** Reference-data version the user was last welcomed for. */
  welcomedVersion?: string;
  /**
   * Resolved runtime paths, persisted so the SessionStart hook can read them —
   * the plugin host does NOT pass userConfig-derived env vars to hook processes.
   */
  env?: { ollamaAddress?: string; claudeCliPath?: string; codexCliPath?: string };
  /**
   * Verified vision-capability results, keyed by model-id label (e.g.
   * "ollama:gemma4:12b", "claude-cli:opus") — the same format as `members`.
   * Only ever holds DEFINITIVE results (never a transient/inconclusive one —
   * those are deliberately never cached at all, in-memory or on disk). Lets a
   * restart skip re-running the OCR-challenge detection round trip for a
   * model already proven capable in a prior session — on a slow machine that
   * round trip can take many seconds per model, which adds up across a
   * multi-member council and would otherwise repeat on every reload.
   */
  visionCapability?: Record<string, boolean>;
}

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
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as CouncilState;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* no state file yet */
  }
  return { version: STATE_VERSION };
}

/**
 * Merge `patch` into the persisted state and write it back atomically (temp file
 * + rename), so a concurrent reader in another process never observes a
 * half-written file. Best-effort — non-fatal if the location is unwritable.
 */
export function saveState(patch: Partial<CouncilState>): CouncilState {
  const next: CouncilState = { ...loadState(), ...patch, version: STATE_VERSION };
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, p); // atomic within a filesystem
  } catch {
    /* best-effort */
  }
  return next;
}
