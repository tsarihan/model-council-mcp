#!/usr/bin/env node
/**
 * Mock of the `codex` CLI for e2e testing of the codex-cli provider.
 * Writes an echo of the flags/env it observed to the `-o` file so tests can
 * assert the provider (a) forced read-only sandbox, (b) passed the model, and
 * (c) stripped OPENAI_API_KEY / CODEX_API_KEY (subscription auth).
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-mock\n');
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
const okey = process.env.OPENAI_API_KEY ? 'set' : 'unset';
const ckey = process.env.CODEX_API_KEY ? 'set' : 'unset';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  process.stderr.write('[mock-codex progress]\n'); // progress goes to stderr
  const result =
    `mock-codex model=${model} okey=${okey} ckey=${ckey} sandbox=${sandbox} ` +
    `:: ${input.trim().slice(0, 500)}`;
  if (outFile) {
    try { writeFileSync(outFile, result); } catch { /* ignore */ }
  } else {
    process.stdout.write(result);
  }
  process.exit(0);
});
