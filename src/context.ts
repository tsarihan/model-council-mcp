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

export const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
export const MAX_TOTAL_BYTES = 768 * 1024; // 768 KB across all files
export const MAX_FILES = 20;
export const MAX_CONTEXT_BYTES = 768 * 1024; // 768 KB inline "context" — matches the files total cap
export const MAX_QUESTION_BYTES = 256 * 1024; // 256 KB "question" — large text belongs in "context"/"files"

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
export async function buildAugmentedQuestion(
  question: string,
  input: ContextInput,
): Promise<string> {
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

  if (blocks.length === 0) return question;

  return (
    `${blocks.join('\n\n')}\n\n` +
    `----- QUESTION:${nonce} -----\n${question}`
  );
}
