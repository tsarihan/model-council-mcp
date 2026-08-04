#!/usr/bin/env node
/**
 * Mock of the `grok` CLI for e2e testing of the grok-cli provider (and of
 * detectGrok()'s login probe). Echoes back the flags/env it observed so tests
 * can assert the provider (a) disabled tools, (b) passed --permission-mode
 * bypassPermissions, (c) stripped XAI_API_KEY, and (d) replaced the persona
 * via --system-prompt-override. Image-bearing calls still arrive as a single
 * --prompt-json argument (ACP-style content blocks, native `image` blocks);
 * text-only calls arrive via --prompt-file (a temp file path) to avoid the
 * OS argv-length limit that --prompt-json alone would hit on a large prompt.
 */
import { readFileSync } from 'node:fs';
import { CHALLENGE_IMAGES, CHALLENGE_PROMPT } from '../dist/vision-challenge.js';

const CHALLENGE_BY_BASE64 = new Map(CHALLENGE_IMAGES.map(c => [c.base64, c.code]));

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('grok 0.0.0-mock\n');
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(code);
}

const model = flag('-m');
const promptJson = flag('--prompt-json');
const promptFile = flag('--prompt-file');
const pPrompt = flag('-p');
const toolsIdx = args.indexOf('--tools');
const toolsValue = toolsIdx !== -1 ? args[toolsIdx + 1] : undefined;
const permMode = flag('--permission-mode');
const sysOverride = flag('--system-prompt-override');
const xkey = process.env.XAI_API_KEY ? 'set' : 'unset';

// detectGrok()'s login probe: `-p "Reply with the single word READY" --output-format json --tools '' --permission-mode bypassPermissions` — no --prompt-json.
if (pPrompt !== undefined) {
  emit({ text: 'READY', stopReason: 'EndTurn', sessionId: 'mock', requestId: 'mock-req', usage: {}, num_turns: 1 });
}

// Simulate a CLI-reported error (exit 1 + {type:"error", message}).
if (model === 'erroring') {
  emit({ type: 'error', message: 'mock grok error: simulated failure' }, 1);
}

let blocks = [];
if (promptJson !== undefined) {
  try { blocks = JSON.parse(promptJson); } catch { /* leave empty */ }
} else if (promptFile !== undefined) {
  // Text-only path: --prompt-file's content is a plain-text prompt, not
  // JSON content blocks (matches the real CLI's documented usage).
  let fileText = '';
  try { fileText = readFileSync(promptFile, 'utf8'); } catch { /* leave empty */ }
  blocks = [{ type: 'text', text: fileText }];
}
const textBlock = blocks.find(b => b.type === 'text');
const imageBlocks = blocks.filter(b => b.type === 'image');
const viaFile = promptFile !== undefined;

// OCR-challenge verification: answer with the code the attached image
// actually encodes, proving the native `image` content block was readable —
// this is what supportsVision() grades to confirm grok-cli can really see it.
if (textBlock?.text?.startsWith(CHALLENGE_PROMPT) && imageBlocks.length) {
  const code = CHALLENGE_BY_BASE64.get(imageBlocks[0].data);
  if (code) {
    emit({ text: code, stopReason: 'EndTurn', sessionId: 'mock', requestId: 'mock-req', usage: {}, num_turns: 1 });
  }
}

// 'none' is the locked-down value. The EMPTY string is NOT: grok reads '' as
// "flag unset" and enables its full tool set (verified live — it ran a shell
// command), so an empty value must NOT report as "off" here either.
const toolsOff = toolsValue === 'none';
const result =
  `mock-grok model=${model ?? '?'} xkey=${xkey} tools=${toolsOff ? 'off' : toolsValue} ` +
  `perm=${permMode ?? 'default'} sys=${sysOverride ? 'override' : 'default'} images=${imageBlocks.length} ` +
  `effort=${flag('--reasoning-effort') ?? 'unset'} ` +
  `via=${viaFile ? 'file' : 'json'} :: ` +
  `${(textBlock?.text ?? '').trim().slice(0, 80)}`;

emit({ text: result, stopReason: 'EndTurn', sessionId: 'mock', requestId: 'mock-req', usage: { tokens: 1 }, num_turns: 1 });
