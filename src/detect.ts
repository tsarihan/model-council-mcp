/**
 * Environment detection: what can the council actually use right now?
 *   • Ollama — reachable? which local chat models? is cloud reachable on this plan?
 *   • Claude CLI — installed AND logged in (a real probe, not just --version)?
 *   • Codex CLI — installed AND signed in (`codex login status`)?
 *
 * Used to (a) auto-populate the council with only what's usable and (b) tell the
 * user what was detected + warn about quota. All probes are timeout-bounded and
 * degrade to "not usable" rather than throwing.
 */
import { spawn } from 'node:child_process';
import { ProviderRegistry } from './providers/registry.js';
import { isEmbeddingModel } from './council/orchestrator.js';
import { Subscriptions, tierAllowsCloud } from './subscriptions.js';
import { SubscriptionTiers } from './types.js';

export interface EnvReport {
  ollama: {
    reachable: boolean;
    localModels: string[];
    /** ok = a curated cloud model responded; failed = tier/plan can't reach cloud; disabled = tier is free; skipped = not probed */
    cloud: 'ok' | 'failed' | 'disabled' | 'skipped';
  };
  claude: { installed: boolean; usable: boolean };
  codex: { installed: boolean; usable: boolean };
}

const isCloudModel = (m: string): boolean => m.endsWith(':cloud') || m.endsWith('-cloud');

interface CliResult { code: number; stdout: string; stderr: string; }

/** Run a CLI with a timeout; optionally strip credentials to force subscription auth. */
function runCli(
  command: string,
  args: string[],
  opts: { timeoutMs: number; input?: string; stripKeys?: 'anthropic' | 'openai' } = { timeoutMs: 8000 },
): Promise<CliResult> {
  return new Promise(resolve => {
    const env = { ...process.env };
    if (opts.stripKeys === 'anthropic') { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
    if (opts.stripKeys === 'openai') { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: 'spawn failed' });
      return;
    }
    let stdout = '', stderr = '', settled = false;
    const done = (r: CliResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } done({ code: 124, stdout, stderr }); }, opts.timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => (stdout += d));
    child.stderr?.on('data', d => (stderr += d));
    child.stdin?.on('error', () => {});
    child.on('error', () => done({ code: 127, stdout, stderr }));
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([p, t]); }
  finally { clearTimeout(timer!); }
}

/** Detect everything the council could use, given the resolved tiers. */
export async function detectEnvironment(
  registry: ProviderRegistry,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): Promise<EnvReport> {
  // ── Ollama ────────────────────────────────────────────────────────────────
  const ollama = registry.getAll().find(p => p.config.type === 'ollama');
  const ollamaReport: EnvReport['ollama'] = { reachable: false, localModels: [], cloud: 'skipped' };
  if (ollama) {
    try {
      const models = await withTimeout(ollama.listModels(), 6000, []);
      ollamaReport.reachable = true;
      ollamaReport.localModels = models
        .filter(m => !isCloudModel(m.model) && !isEmbeddingModel(m))
        .map(m => m.model);
    } catch {
      ollamaReport.reachable = false;
    }
    if (!tierAllowsCloud('ollama', tiers.ollama, subs)) {
      ollamaReport.cloud = 'disabled';
    } else if (ollamaReport.reachable && subs.curatedCloudModels.length) {
      // Probe one curated cloud model to see if this plan can actually reach cloud.
      const probe = withTimeout(
        ollama.complete(subs.curatedCloudModels[0], [{ role: 'user', content: 'hi' }], { maxTokens: 1 })
          .then(() => 'ok' as const)
          .catch(() => 'failed' as const),
        15000,
        'failed' as const,
      );
      ollamaReport.cloud = await probe;
    }
  }

  // ── Claude CLI ──────────────────────────────────────────────────────────────
  const claudeCmd = (process.env.CLAUDE_CLI_PATH || '').trim() && !((process.env.CLAUDE_CLI_PATH || '').includes('${'))
    ? (process.env.CLAUDE_CLI_PATH as string).trim() : 'claude';
  const claudeInstalled = (await runCli(claudeCmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  let claudeUsable = false;
  if (claudeInstalled) {
    const probe = await runCli(
      claudeCmd,
      ['-p', 'Reply with the single word READY', '--output-format', 'text'],
      { timeoutMs: 25000, stripKeys: 'anthropic' },
    );
    claudeUsable = probe.code === 0 && probe.stdout.trim().length > 0;
  }

  // ── Codex CLI ─────────────────────────────────────────────────────────────
  const codexCmd = (process.env.CODEX_CLI_PATH || '').trim() && !((process.env.CODEX_CLI_PATH || '').includes('${'))
    ? (process.env.CODEX_CLI_PATH as string).trim() : 'codex';
  const codexInstalled = (await runCli(codexCmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  let codexUsable = false;
  if (codexInstalled) {
    const st = await runCli(codexCmd, ['login', 'status'], { timeoutMs: 8000 });
    codexUsable = /logged in/i.test(`${st.stdout}\n${st.stderr}`);
  }

  return {
    ollama: ollamaReport,
    claude: { installed: claudeInstalled, usable: claudeUsable },
    codex: { installed: codexInstalled, usable: codexUsable },
  };
}

/**
 * Build the auto-populated council ("everything on") from a detection report and
 * the resolved tiers: local Ollama chat models + curated cloud (if reachable) +
 * logged-in Claude/Codex CLI members (if their tier allows cloud). Returns
 * model-id label strings, de-duplicated.
 */
export function autoPopulatedMembers(
  report: EnvReport,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): string[] {
  const out: string[] = [];
  for (const m of report.ollama.localModels) out.push(`ollama:${m}`);
  if (report.ollama.cloud === 'ok') {
    for (const m of subs.curatedCloudModels) out.push(`ollama:${m}`);
  }
  if (report.claude.usable && tierAllowsCloud('claude', tiers.claude, subs)) {
    for (const m of subs.providers.claude.models ?? []) out.push(`claude-cli:${m}`);
  }
  if (report.codex.usable && tierAllowsCloud('chatgpt', tiers.chatgpt, subs)) {
    for (const m of subs.providers.chatgpt.models ?? []) out.push(`codex-cli:${m}`);
  }
  return [...new Set(out)];
}

/** Human-readable quota warning for the detected/auto-populated council. */
export function quotaWarning(report: EnvReport): string | null {
  const paid: string[] = [];
  if (report.ollama.cloud === 'ok') paid.push('Ollama cloud');
  if (report.claude.usable) paid.push('Claude subscription');
  if (report.codex.usable) paid.push('ChatGPT/Codex subscription');
  if (paid.length === 0) return null;
  return `The council includes ${paid.join(', ')} members — asking it consumes your ${paid.length > 1 ? 'quotas' : 'quota'}. ` +
    `Remove any you don't want with configure_council (or /model-council:setup) to reduce usage.`;
}
