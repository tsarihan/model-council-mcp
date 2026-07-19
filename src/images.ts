/**
 * Load image files attached to an `ask_council` call and decode them for the
 * council's providers.
 *
 * Images are handled entirely separately from `context.ts`'s `files` (text)
 * loader: `files` reads its targets as UTF-8 text, so a binary image passed
 * there would come out as mojibake sent to every member. `images` reads bytes
 * and base64-encodes them, and is routed only to members the orchestrator has
 * confirmed are vision-capable (see orchestrator.ts).
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ChatImage } from './providers/base.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per image
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024; // 24 MB across all images
export const MAX_IMAGES = 6;

const EXT_TO_MIME: Record<string, ChatImage['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Read, validate, and base64-encode each image path. Throws a caller-friendly
 * Error on a missing / unsupported / oversized file — same pattern as
 * `buildAugmentedQuestion` in context.ts, so callers handle both the same way.
 */
export async function loadImages(paths: string[] | undefined): Promise<ChatImage[]> {
  if (!paths?.length) return [];
  if (paths.length > MAX_IMAGES) {
    throw new Error(`Too many images attached (${paths.length}); the limit is ${MAX_IMAGES}.`);
  }

  const out: ChatImage[] = [];
  let total = 0;
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const path = resolve(raw);
    const ext = extname(path).toLowerCase();
    const mimeType = EXT_TO_MIME[ext];
    if (!mimeType) {
      throw new Error(
        `Unsupported image type: ${raw} (supported: ${Object.keys(EXT_TO_MIME).join(', ')}).`,
      );
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`Attached image not found or unreadable: ${raw}`);
    }
    if (!info.isFile()) {
      throw new Error(`Attached path is not a file: ${raw}`);
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Attached image too large: ${raw} (${Math.round(info.size / 1024)} KB > ` +
          `${Math.round(MAX_IMAGE_BYTES / 1024)} KB limit).`,
      );
    }
    total += info.size;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(
        `Attached images exceed the combined ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))} MB limit. ` +
          `Attach fewer/smaller images.`,
      );
    }
    const buf = await readFile(path);
    out.push({ base64: buf.toString('base64'), mimeType });
  }
  return out;
}
