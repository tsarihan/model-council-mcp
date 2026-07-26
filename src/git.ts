/**
 * Auto-attach a local git diff as context for a council question, so a repo
 * review doesn't require hand-listing every changed file via "files". Runs
 * `git diff` on the server's own machine (never a shell — args are passed as
 * an array, so a ref string can't inject anything) and returns the raw diff
 * text for context.ts to fence alongside "context"/"files".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

export const MAX_DIFF_BYTES = 512 * 1024; // 512 KB

// Every other subprocess in this codebase is wall-clock bounded; a hung git
// (stalled network mount, corrupted object database, or a repo-configured
// command that blocks — see GLOBAL_SAFETY_ARGS below) would otherwise block
// a synchronous ask_council call forever, or permanently occupy one of the
// 20 running-job slots for an async call with no way to recover it.
const GIT_TIMEOUT_MS = 15_000;

export interface GitDiffInput {
  /** 'staged' | 'unstaged' | 'uncommitted', or any git revision/range (e.g. "main..HEAD"). */
  ref: string;
  /** Repo directory to run git in. Defaults to the server's cwd. */
  repo?: string;
}

// Disable repo-configured external diff/textconv helpers (.gitattributes
// diff=<driver> / diff.<driver>.command, diff.<driver>.textconv) — without
// this, a plain `git diff` on an untrusted repo can execute an arbitrary
// command the repo itself configured. This is a read-only context-extraction
// feature; it should never run anything the repo defines.
const NO_HELPERS = ['--no-ext-diff', '--no-textconv'];

// Global (must precede the subcommand) safety flags closing the SAME
// arbitrary-command threat model NO_HELPERS targets, for the two mechanisms
// it doesn't cover: `git diff`'s index refresh can invoke a repo-configured
// `core.fsmonitor` command (the query-fsmonitor hook), and any git invocation
// can run a repo-local `core.hooksPath` hook. A "repo" delivered as an
// archive (not a clone — .git/config IS included in a tarball/zip, unlike a
// clone) with either set is a real, documented attack pattern, and this
// feature's whole purpose is reviewing an arbitrary local repo.
const GLOBAL_SAFETY_ARGS = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null'];

// The SHA-1 all-zeros-content empty tree, the common object format. Used as a
// fallback GIT_ATTR_SOURCE and when the dynamic resolution below fails.
const SHA1_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const emptyTreeHashCache = new Map<string, string>();

/**
 * Resolve a repo's EMPTY-tree object hash. NO_HELPERS/GLOBAL_SAFETY_ARGS close
 * external-diff/textconv/fsmonitor/hooks, but a `git diff` of the WORKING TREE
 * ('unstaged'/'uncommitted') must convert working-tree content to object form,
 * which runs a repo-configured `.gitattributes` clean-filter driver
 * (`[filter "x"] clean = <cmd>` in .git/config, activated by an in-tree
 * `.gitattributes` `* filter=x`) — arbitrary command execution the other flags
 * don't cover, and squarely inside the "repo delivered as an archive" threat
 * model GLOBAL_SAFETY_ARGS already names. Pointing GIT_ATTR_SOURCE (git >= 2.40)
 * at the empty tree makes git honor NO .gitattributes at all, so no filter
 * runs. The empty-tree hash differs by object format (SHA-1 vs SHA-256), so we
 * resolve it per-repo via `git hash-object` (hashing /dev/null, which writes
 * nothing and runs no filter) rather than hardcoding — a hardcoded SHA-1 hash
 * would be an invalid object in a SHA-256 repo and could break its diffs.
 * Cached per repoPath (object format is a fixed per-repo property).
 *
 * NOTE: GIT_ATTR_SOURCE is a no-op on git < 2.40, which silently ignores it —
 * the filter mitigation does not apply there. macOS and modern Linux ship
 * git >= 2.40, so the common case is covered; older gits fall back to the
 * pre-existing (still filter-exposed) behavior rather than breaking.
 */
async function emptyTreeHash(repoPath: string): Promise<string> {
  const cached = emptyTreeHashCache.get(repoPath);
  if (cached) return cached;
  let hash = SHA1_EMPTY_TREE;
  try {
    const { stdout } = await execFileAsync(
      'git', ['hash-object', '-t', 'tree', '/dev/null'],
      { cwd: repoPath, timeout: GIT_TIMEOUT_MS },
    );
    const h = stdout.trim();
    if (/^[0-9a-f]{40,64}$/.test(h)) hash = h;
  } catch {
    /* keep the SHA-1 fallback */
  }
  emptyTreeHashCache.set(repoPath, hash);
  return hash;
}

/** Map a friendly alias to `git diff` args; anything else is passed through as a revision/range. */
function diffArgsForRef(ref: string): string[] {
  switch (ref) {
    case 'staged':
      return ['diff', ...NO_HELPERS, '--cached'];
    case 'unstaged':
      return ['diff', ...NO_HELPERS];
    case 'uncommitted':
      return ['diff', ...NO_HELPERS, 'HEAD'];
    default:
      // '--end-of-options' is belt-and-suspenders: the leading-dash check above
      // already rejects anything git could parse as a flag, so this defends
      // only against git version differences in how that check is enforced.
      return ['diff', ...NO_HELPERS, '--end-of-options', ref];
  }
}

/**
 * Throws unless `repoPath` is inside a real git work tree. Exported so callers
 * granting filesystem access based on a caller-supplied path (e.g.
 * full_repo_access's git_repo) can require the same validation git_ref
 * already gets — an unvalidated path here would otherwise accept anything
 * ("/", a home directory, a nonexistent path) as a "repo root" to grant.
 *
 * Checks the command's STDOUT, not just its exit code — `git rev-parse
 * --is-inside-work-tree` exits 0 and prints "false" (not an error) when run
 * from inside a `.git` directory itself (the metadata dir, not the working
 * tree), so an exit-code-only check would accept `<repo>/.git` as a valid
 * "repo root" and grant read access to git internals rather than the actual
 * project. Found via a live council review of this exact function.
 *
 * Also special-cases the resolved path being exactly the user's home
 * directory: a dotfiles repo initialized at `~` is a completely legitimate
 * git work tree, so `--is-inside-work-tree` alone can never distinguish "the
 * small project the caller meant to grant" from "the caller's entire home
 * directory, which happens to also be a repo" — no git-plumbing check closes
 * that gap in general. This one common, high-blast-radius case is rejected
 * explicitly as defense-in-depth; anything narrower under $HOME still passes.
 */
/** realpath if the path exists (resolving symlinks); the resolved-but-unresolved path otherwise. */
function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Case-insensitively compares paths on darwin/win32 (their default
 * filesystems are case-insensitive, so two differently-cased strings can
 * name the identical file — comparing case-sensitively there would let a
 * case-variant path slip past a same-path check).
 */
function samePath(a: string, b: string): boolean {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Validates `repoPath` is a legitimate git work tree and returns its REALPATH
 * (symlinks fully resolved) — callers granting broader access on the strength
 * of this check (e.g. full_repo_access's `--add-dir`) must use the returned
 * canonical path, not their own `path.resolve()` of the original input. Using
 * the original path would leave a TOCTOU window: if the input traverses a
 * symlink, a local attacker could retarget it between this check and the
 * later CLI invocation, granting access to a different directory than the one
 * actually validated here. The canonical path has no such window — the
 * symlink was already dereferenced once and for all before being handed back.
 */
export async function assertGitRepo(repoPath: string): Promise<string> {
  const resolved = resolve(repoPath);
  // realpath (not just path.resolve) so a SYMLINKED home directory — or a
  // symlink pointing INTO the home directory — can't produce a different
  // string than the real $HOME and slip past this check while pointing at
  // the exact same location on disk. Also doubles as the canonicalization
  // this function returns to callers (see doc comment above).
  const canonical = tryRealpath(resolved);
  if (samePath(canonical, tryRealpath(resolve(homedir())))) {
    throw new Error(
      `"${repoPath}" resolves to your home directory — refusing to grant it as a repo root even ` +
        `though it is a valid git work tree. Point at a narrower project directory instead.`,
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: canonical, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' },
    ));
  } catch {
    throw new Error(`"${repoPath}" is not inside a git repository (or git is not installed).`);
  }
  if (stdout.trim() !== 'true') {
    throw new Error(`"${repoPath}" is not inside a git work tree (it may be inside a .git directory).`);
  }
  return canonical;
}

/**
 * Resolve a git_ref into diff text. Throws a caller-friendly Error on a bad
 * ref, a non-repo path, an empty diff (explicitly requested but nothing
 * found), or a diff too large to attach automatically.
 */
export async function buildGitDiff(input: GitDiffInput): Promise<string> {
  const ref = input.ref?.trim();
  if (!ref) {
    throw new Error(
      'git_ref must be a non-empty string: "uncommitted" | "staged" | "unstaged", or a git ' +
        'revision/range like "main..HEAD" or "HEAD~3..HEAD".',
    );
  }
  // A ref beginning with '-' would be parsed by git as an OPTION, not a
  // revision — e.g. "--output=/some/file" makes `git diff` write (and
  // truncate) an arbitrary file, failing silently from our side (empty
  // stdout looks identical to "no changes"). No legitimate revision, range,
  // or alias ever starts with '-', so reject it outright rather than trying
  // to allowlist safe-looking flags.
  if (ref.startsWith('-')) {
    throw new Error(
      `git_ref "${ref}" looks like a git option, not a revision/range — refusing it. Use ` +
        '"uncommitted" | "staged" | "unstaged", or a revision/range like "main..HEAD".',
    );
  }

  // Use assertGitRepo's returned REALPATH, not the pre-realpath input, as the
  // actual `git diff` cwd — the exact same TOCTOU class round 3 closed for
  // full_repo_access's --add-dir grant: a symlink in the path could be
  // retargeted between validation (including the $HOME rejection, which runs
  // against the canonical path) and this execFileAsync call, so a diff
  // taken from `repoPath` alone could come from a directory that was never
  // actually checked.
  const repoPath = await assertGitRepo(resolve(input.repo?.trim() || process.cwd()));

  const args = [...GLOBAL_SAFETY_ARGS, ...diffArgsForRef(ref)];
  // Neutralize attribute-driven clean/smudge filters (see emptyTreeHash) by
  // sourcing .gitattributes from the empty tree — no attributes, no filters.
  const attrSource = await emptyTreeHash(repoPath);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      env: { ...process.env, GIT_ATTR_SOURCE: attrSource },
      maxBuffer: MAX_DIFF_BYTES * 2,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`git diff failed for git_ref "${ref}": ${detail.trim().slice(0, 300)}`);
  }

  if (!stdout.trim()) {
    throw new Error(`No changes found for git_ref "${ref}" in ${repoPath} — nothing to review.`);
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_DIFF_BYTES) {
    throw new Error(
      `git diff for "${ref}" is too large (> ${Math.round(MAX_DIFF_BYTES / 1024)} KB) to attach ` +
        `automatically. Narrow the range (e.g. a smaller commit range) or attach specific files ` +
        `via "files" instead.`,
    );
  }
  return stdout;
}
