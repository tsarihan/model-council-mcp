/**
 * Auto-attach a local git diff as context for a council question, so a repo
 * review doesn't require hand-listing every changed file via "files". Runs
 * `git diff` on the server's own machine (never a shell — args are passed as
 * an array, so a ref string can't inject anything) and returns the raw diff
 * text for context.ts to fence alongside "context"/"files".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export const MAX_DIFF_BYTES = 512 * 1024; // 512 KB

export interface GitDiffInput {
  /** 'staged' | 'unstaged' | 'uncommitted', or any git revision/range (e.g. "main..HEAD"). */
  ref: string;
  /** Repo directory to run git in. Defaults to the server's cwd. */
  repo?: string;
}

/** Map a friendly alias to `git diff` args; anything else is passed through as a revision/range. */
function diffArgsForRef(ref: string): string[] {
  switch (ref) {
    case 'staged':
      return ['diff', '--cached'];
    case 'unstaged':
      return ['diff'];
    case 'uncommitted':
      return ['diff', 'HEAD'];
    default:
      // '--end-of-options' is belt-and-suspenders: the leading-dash check above
      // already rejects anything git could parse as a flag, so this defends
      // only against git version differences in how that check is enforced.
      return ['diff', '--end-of-options', ref];
  }
}

async function assertGitRepo(repoPath: string): Promise<void> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  } catch {
    throw new Error(`"${repoPath}" is not inside a git repository (or git is not installed).`);
  }
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

  const repoPath = resolve(input.repo?.trim() || process.cwd());
  await assertGitRepo(repoPath);

  const args = diffArgsForRef(ref);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', args, { cwd: repoPath, maxBuffer: MAX_DIFF_BYTES * 2 }));
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
