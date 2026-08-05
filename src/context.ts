/**
 * Build the prompt actually sent to the council from the raw question plus any
 * inline context and/or files the caller attached.
 *
 * Files are read from the local filesystem (the server runs on the user's own
 * machine), with hard caps so a stray large file can't blow every member's
 * context window or stall the run. Each file is fenced and labelled so models
 * can tell attachments apart from the question.
 */
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { buildGitDiff } from './git.js';
import { envInt } from './config.js';

// Input send-caps. These bound what the tool feeds the council PER CALL — a
// large attachment is multiplied across every member × every round, so an
// unbounded context is a real memory/latency/token amplifier, not just a
// per-request size. Env-configurable (KB) so a user running a council of
// large-context models (e.g. Ollama 256K local / 1M :cloud) can feed more,
// while the defaults stay modest enough not to surprise a mixed council.
//
// NOTE: the practical ceiling is the SMALLEST member's context window, not
// these caps — sending ~1MB (~300K tokens) to a 256K-context local member
// makes clampMaxTokens raise a clear PromptTooLargeError for THAT member (it
// still degrades per-member, others answer), so raise these when your council
// is all-cloud/large-context, and keep them lower for mixed local councils.
export const MAX_FILE_BYTES = envInt('MAX_FILE_KB', 512) * 1024; // per file (was 256KB)
export const MAX_TOTAL_BYTES = envInt('MAX_TOTAL_KB', 1536) * 1024; // across all files (was 768KB)
export const MAX_FILES = envInt('MAX_FILES', 32); // (was 20)
export const MAX_CONTEXT_BYTES = envInt('MAX_CONTEXT_KB', 1024) * 1024; // inline "context" (was 768KB)
export const MAX_QUESTION_BYTES = envInt('MAX_QUESTION_KB', 256) * 1024; // "question" — large text belongs in context/files

/** Binary image extensions are rejected here — read as UTF-8 they become
 *  mojibake sent to every member. Use the `images` parameter instead, which
 *  base64-encodes them and routes only to vision-capable members. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

export interface ContextInput {
  context?: string; // inline background text
  files?: string[]; // paths to read and attach
  gitRef?: string; // e.g. "uncommitted" | "staged" | "unstaged" | "main..HEAD"
  gitRepo?: string; // repo directory for the diff; defaults to the server's cwd
}

/**
 * Returns the composed prompt. When there is nothing to attach, the original
 * question is returned unchanged (so the common case is untouched).
 * Throws a caller-friendly Error on a missing / oversized / unreadable file.
 */
export interface AugmentedQuestion {
  text: string;
  /**
   * The random fence nonce embedded in `text` (undefined when nothing was
   * attached and `text` is the bare question). Returned so the CALLER can
   * normalize it out of derived values — the repeat-ask cache key hashed the
   * augmented text directly, and the per-call nonce made every
   * context/files/git_ref ask a guaranteed cache miss: a dead cache that
   * looked alive. The nonce itself must STAY random in the prompt — it is the
   * forged-fence-marker defense against untrusted attachment content — so the
   * fix is normalization at the use site, never determinism at the source.
   */
  nonce?: string;
}

export async function buildAugmentedQuestion(
  question: string,
  input: ContextInput,
): Promise<AugmentedQuestion> {
  // "files"/"images"/git diffs are all capped; "question" and "context" were
  // not, despite becoming part of the SAME prompt re-sent to every member on
  // every round of a multi-round mode — an unbounded value here scales with
  // council size × round count in a way none of the other caps guard against.
  const questionBytes = Buffer.byteLength(question, 'utf8');
  if (questionBytes > MAX_QUESTION_BYTES) {
    throw new Error(
      `"question" is too large (${Math.round(questionBytes / 1024)} KB > ` +
        `${Math.round(MAX_QUESTION_BYTES / 1024)} KB limit). Attach large text via "context" or "files" instead.`,
    );
  }

  const blocks: string[] = [];
  // A random per-call token embedded in every fence marker below. Attached
  // file/diff content is untrusted (it can come from an arbitrary local file
  // or a git diff in a repo under review) — without a nonce, a fixed marker
  // string like "----- QUESTION -----" could be forged by content that
  // contains that exact line, tricking a member into treating attacker text
  // as the real question. The nonce can't be predicted in advance, so a
  // forged marker in attached content won't match the real one.
  const nonce = randomUUID().slice(0, 8);

  const inline = input.context?.trim();
  if (inline) {
    const contextBytes = Buffer.byteLength(inline, 'utf8');
    if (contextBytes > MAX_CONTEXT_BYTES) {
      throw new Error(
        `"context" is too large (${Math.round(contextBytes / 1024)} KB > ` +
          `${Math.round(MAX_CONTEXT_BYTES / 1024)} KB limit). Narrow it, or attach specific files via "files" instead.`,
      );
    }
    blocks.push(`----- CONTEXT:${nonce} -----\n${inline}`);
  }

  if (input.gitRef?.trim()) {
    const diff = await buildGitDiff({ ref: input.gitRef, repo: input.gitRepo });
    blocks.push(`----- GIT DIFF:${nonce} (${input.gitRef.trim()}) -----\n${diff}`);
  }

  const files = input.files ?? [];
  if (files.length > MAX_FILES) {
    throw new Error(`Too many files attached (${files.length}); the limit is ${MAX_FILES}.`);
  }

  let total = 0;
  for (const raw of files) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const path = resolve(raw);
    if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new Error(
        `${raw} looks like an image — "files" reads text and would send garbled data. Use the "images" parameter instead.`,
      );
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`Attached file not found or unreadable: ${raw}`);
    }
    if (!info.isFile()) {
      throw new Error(`Attached path is not a file: ${raw}`);
    }
    // Fast-path rejection on the stat'd size (avoids reading an obviously-huge
    // file at all), but NOT the only check — see the actual-size check below.
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `Attached file too large: ${raw} (${Math.round(info.size / 1024)} KB > ` +
          `${Math.round(MAX_FILE_BYTES / 1024)} KB limit). Trim it or pass an excerpt via "context".`,
      );
    }
    let buf: Buffer;
    try {
      buf = await readFile(path); // no encoding — raw bytes, so a binary sniff can run before decoding
    } catch {
      throw new Error(`Could not read attached file: ${raw}`);
    }
    // Re-check against the ACTUAL bytes read, not just the earlier stat() —
    // stat-then-read is a TOCTOU window (e.g. a symlink retargeted between the
    // two calls) that could otherwise smuggle a larger file past the size cap.
    if (buf.byteLength > MAX_FILE_BYTES) {
      throw new Error(
        `Attached file too large: ${raw} (${Math.round(buf.byteLength / 1024)} KB > ` +
          `${Math.round(MAX_FILE_BYTES / 1024)} KB limit). Trim it or pass an excerpt via "context".`,
      );
    }
    // Binary sniff: a NUL byte essentially never appears in genuine text, but
    // is common in binary formats (wasm/pdf/zip/sqlite/etc.) that don't carry
    // an image extension. readFile(path, 'utf8') never throws on invalid
    // UTF-8 — it silently substitutes replacement characters — so without
    // this check a binary file would decode to mojibake and get fenced and
    // sent to every member as if it were real content. Same heuristic git
    // itself uses to classify a file as binary.
    if (buf.subarray(0, 8000).includes(0)) {
      throw new Error(
        `${raw} looks like a binary file (contains a NUL byte) — "files" reads text and would send ` +
          `garbled data. If this is meant to be an image, use the "images" parameter instead.`,
      );
    }
    const body = buf.toString('utf8');
    total += buf.byteLength;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        `Attached files exceed the combined ${Math.round(MAX_TOTAL_BYTES / 1024)} KB limit. ` +
          `Attach fewer/smaller files.`,
      );
    }
    blocks.push(`----- FILE:${nonce}: ${raw} -----\n${body}`);
  }

  if (blocks.length === 0) return { text: question };

  return {
    text: (
      `${blocks.join('\n\n')}\n\n` +
    `----- QUESTION:${nonce} -----\n${question}`
    ),
    nonce,
  };
}
