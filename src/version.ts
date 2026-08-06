/**
 * The running server's own version, reported by `council_status` and
 * `get_council_config`.
 *
 * WHY THIS EXISTS. `/reload-plugins` — including `--force` — does not restart an
 * already-running plugin MCP server process (verified 2026-08-05: two forced
 * reloads, same PID, 20-minute uptime spanning both). So several sessions on one
 * machine routinely talk to DIFFERENT builds at the same time, all sharing one
 * `~/.config/model-council/state.json`. Before this field the only way to tell
 * which build answered was to recognise wording unique to a version, or to go
 * read `ps` — behavioural inference, in a project whose whole discipline is that
 * a claim needs evidence. A post-update check should be one call.
 *
 * Read from `package.json` rather than hard-coded, because a hard-coded constant
 * is one more thing that can silently disagree with the version everything else
 * reports (three manifests in the fork had already drifted). package.json ships
 * one directory above BOTH build outputs — `<root>/bundle/server.cjs`,
 * `<root>/dist/index.js`, and `<root>/src/index.ts` under tsx — so one relative
 * hop covers bundle, dist, and dev.
 *
 * Never throws and never fails the server: an unreadable/absent package.json
 * yields `'unknown'`, matching the project rule that a diagnostic must not be
 * able to take down the thing it reports on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Best-effort module directory: __dirname in the CJS bundle, import.meta.url under ESM/tsx. */
function moduleDir(): string | undefined {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {
    /* ESM — no __dirname */
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    /* no import.meta */
  }
  return undefined;
}

/** Reported when the version genuinely cannot be determined — never an empty string. */
export const UNKNOWN_VERSION = 'unknown';

/**
 * Candidate package.json locations, most authoritative first. Exported with
 * explicit `dir`/`cwd` so tests can prove the MODULE-RELATIVE hop works on its
 * own: in this repo the cwd fallback happens to resolve to the same file, so an
 * end-to-end assertion cannot tell a working bundle-relative path from a broken
 * one masked by cwd. In the installed plugin the server's cwd is arbitrary and
 * only the module-relative hop can succeed.
 */
export function candidatePaths(dir: string | undefined, cwd: string): string[] {
  const out: string[] = [];
  // One hop up from bundle/ or dist/ (the installed plugin keeps package.json at
  // its root); then the same dir, for a layout that co-locates them.
  if (dir) out.push(join(dir, '..', 'package.json'), join(dir, 'package.json'));
  out.push(join(cwd, 'package.json'));
  return out;
}

/** Pure, testable resolution over a candidate list. Never throws. */
export function readVersionFrom(paths: readonly string[]): string {
  for (const p of paths) {
    try {
      const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version;
      // Guard the shape: a package.json with a non-string/blank version must fall
      // through to the next candidate rather than report `undefined` as a version.
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      /* unreadable/unparseable — try the next candidate */
    }
  }
  return UNKNOWN_VERSION;
}

/**
 * Resolved once at module load. The file cannot change under a running process
 * in any way that matters — an update installs to a NEW directory and the old
 * process keeps serving the old bundle, which is precisely the situation this
 * field exists to expose.
 */
export const SERVER_VERSION: string = readVersionFrom(candidatePaths(moduleDir(), process.cwd()));
