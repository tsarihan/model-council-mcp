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
import { extname, resolve } from 'node:path';

export const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
export const MAX_TOTAL_BYTES = 768 * 1024; // 768 KB across all files
export const MAX_FILES = 20;

/** Binary image extensions are rejected here — read as UTF-8 they become
 *  mojibake sent to every member. Use the `images` parameter instead, which
 *  base64-encodes them and routes only to vision-capable members. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

export interface ContextInput {
  context?: string; // inline background text
  files?: string[]; // paths to read and attach
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
  const blocks: string[] = [];

  const inline = input.context?.trim();
  if (inline) {
    blocks.push(`----- CONTEXT -----\n${inline}`);
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
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `Attached file too large: ${raw} (${Math.round(info.size / 1024)} KB > ` +
          `${Math.round(MAX_FILE_BYTES / 1024)} KB limit). Trim it or pass an excerpt via "context".`,
      );
    }
    total += info.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        `Attached files exceed the combined ${Math.round(MAX_TOTAL_BYTES / 1024)} KB limit. ` +
          `Attach fewer/smaller files.`,
      );
    }
    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch {
      throw new Error(`Could not read attached file as UTF-8 text: ${raw}`);
    }
    blocks.push(`----- FILE: ${raw} -----\n${body}`);
  }

  if (blocks.length === 0) return question;

  return (
    `${blocks.join('\n\n')}\n\n` +
    `----- QUESTION -----\n${question}`
  );
}
