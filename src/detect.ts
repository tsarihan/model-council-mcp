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

/** Resolve a CLI path from an env var, treating unsubstituted placeholders as unset. */
function cliPath(envVar: string, fallback: string): string {
  const v = (process.env[envVar] || '').trim();
  return v && !v.includes('${') ? v : fallback;
}

async function detectOllama(
  registry: ProviderRegistry,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): Promise<EnvReport['ollama']> {
  const ollama = registry.getAll().find(p => p.config.type === 'ollama');
  const report: EnvReport['ollama'] = { reachable: false, localModels: [], cloud: 'skipped' };
  if (!ollama) return report;
  try {
    const models = await withTimeout(ollama.listModels(), 6000, []);
    report.reachable = true;
    report.localModels = models
      .filter(m => !isCloudModel(m.model) && !isEmbeddingModel(m))
      .map(m => m.model);
  } catch {
    report.reachable = false;
  }
  if (!tierAllowsCloud('ollama', tiers.ollama, subs)) {
    report.cloud = 'disabled';
  } else if (report.reachable && subs.curatedCloudModels.length) {
    // Probe one curated cloud model to see if this plan can actually reach cloud.
    report.cloud = await withTimeout(
      ollama.complete(subs.curatedCloudModels[0], [{ role: 'user', content: 'hi' }], { maxTokens: 1 })
        .then(() => 'ok' as const)
        .catch(() => 'failed' as const),
      15000,
      'failed' as const,
    );
  }
  return report;
}

async function detectClaude(): Promise<EnvReport['claude']> {
  const cmd = cliPath('CLAUDE_CLI_PATH', 'claude');
  const installed = (await runCli(cmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  if (!installed) return { installed: false, usable: false };
  // Lock the probe down exactly like the completion path: no tools, strict MCP
  // config (so it does NOT load — and recurse into — this very plugin), and no
  // session persistence. Without --strict-mcp-config this would boot a nested
  // model-council and cascade.
  const probe = await runCli(
    cmd,
    ['-p', 'Reply with the single word READY', '--output-format', 'text',
      '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
    { timeoutMs: 20000, stripKeys: 'anthropic' },
  );
  return { installed: true, usable: probe.code === 0 && probe.stdout.trim().length > 0 };
}

async function detectCodex(): Promise<EnvReport['codex']> {
  const cmd = cliPath('CODEX_CLI_PATH', 'codex');
  const installed = (await runCli(cmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  if (!installed) return { installed: false, usable: false };
  const st = await runCli(cmd, ['login', 'status'], { timeoutMs: 8000 });
  const out = `${st.stdout}\n${st.stderr}`;
  // NB: "Not logged in" contains "logged in" — must exclude it explicitly.
  const usable = /logged in/i.test(out) && !/not logged in/i.test(out);
  return { installed: true, usable };
}

/** Detect everything the council could use, given the resolved tiers. Probes run concurrently. */
export async function detectEnvironment(
  registry: ProviderRegistry,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): Promise<EnvReport> {
  const [ollama, claude, codex] = await Promise.all([
    detectOllama(registry, tiers, subs),
    detectClaude(),
    detectCodex(),
  ]);
  return { ollama, claude, codex };
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

/**
 * Human-readable quota warning for the actually-auto-populated council. Gated by
 * tier the same way autoPopulatedMembers is, so it never warns about a provider
 * whose members were excluded (e.g. a logged-in CLI on a free tier).
 */
export function quotaWarning(
  report: EnvReport,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): string | null {
  const paid: string[] = [];
  if (report.ollama.cloud === 'ok') paid.push('Ollama cloud');
  if (report.claude.usable && tierAllowsCloud('claude', tiers.claude, subs)) paid.push('Claude subscription');
  if (report.codex.usable && tierAllowsCloud('chatgpt', tiers.chatgpt, subs)) paid.push('ChatGPT/Codex subscription');
  if (paid.length === 0) return null;
  return `The council includes ${paid.join(', ')} members — asking it consumes your ${paid.length > 1 ? 'quotas' : 'quota'}. ` +
    `Remove any you don't want with configure_council (or /model-council:setup) to reduce usage.`;
}
