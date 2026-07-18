#!/usr/bin/env node
/**
 * SessionStart hook (Claude Code plugin only): print a compact, one-line
 * model-council status as session context. Deliberately CHEAP — it must run on
 * every session, so it only does `--version` checks + a quick Ollama ping and
 * reads the persisted council count. The full detection (login probes, cloud
 * probe, quota) lives in the `council_status` tool, run on demand. Never throws.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const clean = (v) =>
  (typeof v === 'string' && v.trim() && !v.includes('${') ? v.trim() : undefined);

function statePath() {
  const override = clean(process.env.MODEL_COUNCIL_STATE);
  if (override) return override;
  const base = clean(process.env.XDG_CONFIG_HOME) ?? join(homedir(), '.config');
  return join(base, 'model-council', 'state.json');
}

/** Read the persisted state once (member count + resolved env the hook can't get from userConfig). */
function readState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function cliInstalled(cmd) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, ['--version'], { timeout: 4000 }, (err) => resolve(!err));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function ollamaLocalCount(url) {
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d.models) ? d.models.length : 0;
  } catch {
    return null;
  }
}

async function main() {
  // userConfig env isn't passed to hook processes, so fall back to the paths the
  // server persisted to state (env), then the plain defaults.
  const state = readState();
  const sEnv = (state && typeof state.env === 'object' && state.env) || {};
  const claudeCmd = clean(process.env.CLAUDE_CLI_PATH) ?? clean(sEnv.claudeCliPath) ?? 'claude';
  const codexCmd = clean(process.env.CODEX_CLI_PATH) ?? clean(sEnv.codexCliPath) ?? 'codex';
  const ollamaUrl = clean(process.env.OLLAMA_ADDRESS) ?? clean(sEnv.ollamaAddress) ?? 'http://localhost:11434';
  const [claude, codex, ollama] = await Promise.all([
    cliInstalled(claudeCmd),
    cliInstalled(codexCmd),
    ollamaLocalCount(ollamaUrl),
  ]);
  const n = Array.isArray(state.members) ? state.members.length : null;
  const parts = [
    n != null ? `${n}-member council ready` : 'council auto-populates on first use',
    ollama != null ? `Ollama up (${ollama} local)` : 'Ollama offline',
    `Claude CLI ${claude ? '✓' : '✗'}`,
    `Codex CLI ${codex ? '✓' : '✗'}`,
  ];
  process.stdout.write(
    `[model-council] ${parts.join(' · ')}. Run /model-council:status for login + quota detail, ` +
    `/model-council:setup to choose subscription tiers.\n`,
  );
}

main().catch(() => { /* never break session start */ });
