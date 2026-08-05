#!/usr/bin/env node
/**
 * Mock of the `codex` CLI for e2e testing of the codex-cli provider.
 * Writes an echo of the flags/env it observed to the `-o` file so tests can
 * assert the provider (a) forced read-only sandbox, (b) passed the model, and
 * (c) stripped OPENAI_API_KEY / CODEX_API_KEY (subscription auth).
 *
 * Vision: also collects every repeated `-i <path>` (the CLI's first-party
 * image-attach flag) and actually reads each file, proving the provider wrote
 * real, accessible image bytes at the paths it passed.
 *
 * Full repo access: reports the `-C <dir>` working root it was given and
 * genuinely lists it (readdirSync), so a test can prove the provider pointed
 * codex at a real repo instead of the usual empty ephemeral dir.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHALLENGE_IMAGES, CHALLENGE_PROMPT } from '../dist/vision-challenge.js';

const CHALLENGE_BY_BASE64 = new Map(CHALLENGE_IMAGES.map(c => [c.base64, c.code]));

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-mock\n');
  process.exit(0);
}

// `codex login status` — detection uses this to check ChatGPT sign-in.
if (args.includes('login') && args.includes('status')) {
  process.stdout.write(process.env.CODEX_MOCK_LOGGED_OUT ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}

const flag = (...names) => {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) return args[i + 1];
  }
  return undefined;
};

const outFile = flag('-o', '--output-last-message');
const model = flag('-m', '--model') ?? 'default';
const sandbox = flag('-s', '--sandbox') ?? '?';
const cwd = flag('-C', '--cd');
const okey = process.env.OPENAI_API_KEY ? 'set' : 'unset';
const ckey = process.env.CODEX_API_KEY ? 'set' : 'unset';

// Scratch: under workspace-write the cwd IS the member's writable scratch —
// behave like a member that saved a long finding there so collection tests
// see a real file arrive through the codex path too.
if (sandbox === 'workspace-write' && cwd) {
  try { writeFileSync(join(cwd, 'mock-finding.md'), `MOCK-FINDING from ${model}\n`); } catch { /* tests notice */ }
}

// Full repo access: genuinely list the -C working root, proving the provider
// pointed codex at a real, listable repo directory (vs. the usual empty
// ephemeral dir, which lists as empty).
let cwdListing = 'nocwd';
if (cwd) {
  try {
    cwdListing = `cwdlist:${readdirSync(cwd).sort().join('|')}`;
  } catch {
    cwdListing = 'cwdlist:ERROR';
  }
}

// Collect every `-i <path>` (repeated for multiple images).
const imagePaths = args.reduce((acc, a, i) => {
  if (a === '-i' || a === '--image') acc.push(args[i + 1]);
  return acc;
}, []);
const imageSummary = imagePaths.length
  ? `images:${imagePaths.map(p => {
      try { return `OK(${p},${readFileSync(p).length}b)`; } catch { return `MISSING(${p})`; }
    }).join('|')}`
  : 'noimages';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  process.stderr.write('[mock-codex progress]\n'); // progress goes to stderr

  // OCR-challenge verification: genuinely "read" the first attached image
  // (real bytes at the path the provider passed via -i) and answer with the
  // code it actually encodes — this is what supportsVision() grades to
  // confirm codex-cli can really see an attached image.
  let challengeAnswer;
  if (imagePaths.length && input.includes(CHALLENGE_PROMPT)) {
    try { challengeAnswer = CHALLENGE_BY_BASE64.get(readFileSync(imagePaths[0]).toString('base64')); } catch { /* fall through */ }
  }
  // `-c model_reasoning_effort="high"` — echoed so a test can prove the effort
  // reached the argv, and in the exact TOML-quoted form codex parses.
  const effortCfg = args.find(a => a.startsWith('model_reasoning_effort='));
  const webCfg = args.some(a => a === 'tools.web_search=true');
  const result = challengeAnswer ??
    `mock-codex model=${model} okey=${okey} ckey=${ckey} sandbox=${sandbox} ${imageSummary} ${cwdListing} ` +
    `effort=${effortCfg ? effortCfg.slice('model_reasoning_effort='.length).replace(/"/g, '') : 'unset'} ` +
    `web=${webCfg ? 'on' : 'off'} ` +
    `:: ${input.trim().slice(0, 500)}`;
  if (outFile) {
    try { writeFileSync(outFile, result); } catch { /* ignore */ }
  } else {
    process.stdout.write(result);
  }
  process.exit(0);
});
