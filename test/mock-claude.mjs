#!/usr/bin/env node
/**
 * Mock of the `claude` CLI for e2e testing of the claude-cli provider.
 * Echoes back the flags/env it observed so tests can assert the provider
 * (a) disabled tools, (b) used strict MCP, and (c) stripped ANTHROPIC_API_KEY.
 *
 * Vision: also simulates the `--tools Read --add-dir <dir>` path — it reads
 * back the actual bytes of any image path referenced in the prompt (proving
 * the mock, standing in for the real Read tool, genuinely could access the
 * file at that path) and reports whether each path fell inside --add-dir.
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('claude 0.0.0-mock\n');
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const model = flag('--model') ?? '?';
  // Simulate a CLI failure reported with exit 0 + is_error (rate limit, etc.).
  if (model === 'erroring') {
    process.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 'mock' }),
    );
    process.exit(0);
  }
  const toolsIdx = args.indexOf('--tools');
  const toolsValue = toolsIdx !== -1 ? args[toolsIdx + 1] : undefined;
  const toolsOff = toolsValue === '';
  const toolsReadOnly = toolsValue === 'Read';
  const addDir = flag('--add-dir');
  const strictMcp = args.includes('--strict-mcp-config');
  const sysReplace = args.includes('--system-prompt');
  const key = process.env.ANTHROPIC_API_KEY ? 'KEYSET' : 'nokey';

  // Simulate the Read tool: extract image paths named in the prompt (the real
  // provider embeds them as "...Read each one...: /path/a.png, /path/b.png")
  // and actually read each file, proving the mock could reach it. Reports
  // whether every path fell inside the granted --add-dir, the same boundary
  // the real CLI enforces.
  let readSummary = 'noimages';
  const pathMatch = input.match(/Read each one with the Read tool before answering: (.+)\)/);
  if (toolsReadOnly && pathMatch) {
    const paths = pathMatch[1].split(', ').map(p => p.trim());
    const reads = paths.map(p => {
      const inScope = !!addDir && dirname(p) === addDir;
      if (!inScope) return `DENIED(${p})`;
      try {
        const bytes = readFileSync(p);
        return `OK(${p},${bytes.length}b)`;
      } catch {
        return `MISSING(${p})`;
      }
    });
    readSummary = `read:${reads.join('|')}`;
  }

  const result =
    `mock-claude model=${model} key=${key} tools=${toolsOff ? 'off' : toolsReadOnly ? 'read' : 'on'} ` +
    `mcp=${strictMcp ? 'strict' : 'default'} sys=${sysReplace ? 'replace' : 'default'} ${readSummary} :: ${input.trim().slice(0, 80)}`;
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result,
      session_id: 'mock',
      total_cost_usd: 0,
    }),
  );
  process.exit(0);
});
