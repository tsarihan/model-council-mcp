import { deflateSync } from 'node:zlib';

/**
 * Behavioral OCR-challenge verification for vision-capability detection.
 *
 * The cheap checks providers already do (Ollama's `/api/show` capabilities
 * field, an OpenAI-compatible server accepting an `image_url` part without
 * erroring) are trustworthy as NEGATIVES but not as positives: a server can
 * accept a multipart image request and silently ignore the unsupported part
 * (observed live with SGLang serving a non-vision Qwen2.5-0.5B-Instruct), and
 * Ollama's capabilities metadata can be stale for custom/quantized model
 * builds that dropped the vision projector during conversion (documented
 * upstream: unsloth#2290, ollama#9967) while still reporting `vision`.
 *
 * This module renders small images each containing a distinct, known 4-digit
 * code and grades the model's raw-text response against it — a "yes" is only
 * trusted once the model has proven it can actually read pixels.
 */

// --- 5x7 dot-matrix digit font: each digit is 7 rows of a 5-bit string ('1' = ink). ---
const FONT_5X7: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buf: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Render `digits` as a high-contrast, generously-sized PNG: thick black
 * strokes on white, wide padding. Sized for legibility, not minimalism —
 * vision models patchify/downscale to a fixed token grid, so a genuinely
 * tiny render can make even a real vision model misread it (a false negative
 * worse than the false positive this challenge exists to catch). Validated
 * live against Claude and Codex CLIs at this exact size before being wired
 * into any provider.
 */
function renderDigitsPNG(digits: string): Buffer {
  const SCALE = 14; // pixels per font-cell pixel — thick, legible strokes
  const DIGIT_W = 5 * SCALE;
  const DIGIT_H = 7 * SCALE;
  const GAP = SCALE * 2;
  const PAD = SCALE * 3;
  const width = digits.length * DIGIT_W + (digits.length - 1) * GAP + PAD * 2;
  const height = DIGIT_H + PAD * 2;
  const stride = 1 + width * 3; // 1 filter-type byte + RGB per row

  const raw = Buffer.alloc(height * stride, 0xff); // white background
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter type 0 (none) per row

  const setPixel = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const off = y * stride + 1 + x * 3;
    raw[off] = 0;
    raw[off + 1] = 0;
    raw[off + 2] = 0;
  };

  digits.split('').forEach((ch, di) => {
    const font = FONT_5X7[ch];
    if (!font) return;
    const ox = PAD + di * (DIGIT_W + GAP);
    for (let fy = 0; fy < 7; fy++) {
      for (let fx = 0; fx < 5; fx++) {
        if (font[fy][fx] !== '1') continue;
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) setPixel(ox + fx * SCALE + sx, PAD + fy * SCALE + sy);
        }
      }
    }
  });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface ChallengeImage {
  code: string;
  base64: string;
  mimeType: 'image/png';
}

// None start with '0' — sidesteps any ambiguity over a model dropping a
// leading zero when reading a rendered digit string as a number.
const CHALLENGE_CODES = [
  '3456', '8974', '1203', '6712', '9045',
  '2589', '7361', '4820', '5197', '8034',
];

/** Precomputed once at module load — cheap (zlib deflate of a small bitmap). */
export const CHALLENGE_IMAGES: ChallengeImage[] = CHALLENGE_CODES.map((code) => ({
  code,
  base64: renderDigitsPNG(code).toString('base64'),
  mimeType: 'image/png' as const,
}));

export const CHALLENGE_PROMPT =
  'Reply with ONLY the 4-digit number shown in the attached image. No other text, ' +
  'no punctuation, no explanation — just the four digits.';

/** Pick `n` distinct challenges at random. */
export function pickChallenges(n: number): ChallengeImage[] {
  const pool = [...CHALLENGE_IMAGES];
  const out: ChallengeImage[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * True iff `code` appears in `response` as an exact digit run, after
 * stripping whitespace/comma/dash separators a model might insert between
 * digits (e.g. "3 4 5 6" or "3-4-5-6"). Matching on maximal digit runs (not
 * substring search) means a wrong-but-longer hallucinated number correctly
 * does NOT match the shorter true code.
 */
export function matchesCode(response: string, code: string): boolean {
  const normalized = response.replace(/[\s,-]/g, '');
  const runs: string[] = normalized.match(/\d+/g) ?? [];
  return runs.includes(code);
}

export type ChallengeOutcome = 'pass' | 'fail' | 'inconclusive';

/**
 * Run the OCR-challenge verification: try up to 2 distinct challenge images,
 * pass if either is read correctly. `ask` sends ONE challenge and returns the
 * model's raw text response.
 *
 * Caching discipline: a thrown error or empty/whitespace-only response is
 * treated as inconclusive for THAT attempt only — never counted toward a
 * negative. Only a clean, non-empty, wrong answer counts toward 'fail'. This
 * matters because vision-capable "thinking" models can burn their token
 * budget on reasoning and return empty content on a transient hiccup; that
 * must not permanently mislabel a genuinely capable model as blind.
 */
export async function verifyVisionChallenge(
  ask: (challenge: ChallengeImage) => Promise<string>,
): Promise<ChallengeOutcome> {
  const challenges = pickChallenges(2);
  let sawCleanWrongAnswer = false;
  for (const challenge of challenges) {
    let response: string;
    try {
      response = await ask(challenge);
    } catch {
      continue;
    }
    if (!response?.trim()) continue;
    if (matchesCode(response, challenge.code)) return 'pass';
    sawCleanWrongAnswer = true;
  }
  return sawCleanWrongAnswer ? 'fail' : 'inconclusive';
}
