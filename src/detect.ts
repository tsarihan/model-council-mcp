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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from './providers/registry.js';
import { isEmbeddingModel } from './council/orchestrator.js';
import { Subscriptions, tierAllowsCloud } from './subscriptions.js';
import { SubscriptionTiers } from './types.js';
import { envBool } from './config.js';
import { CappedBuffer } from './providers/base.js';

export interface EnvReport {
  ollama: {
    reachable: boolean;
    localModels: string[];
    /** ok = a curated cloud model responded; failed = tier/plan can't reach cloud; disabled = tier is free; skipped = not probed */
    cloud: 'ok' | 'failed' | 'disabled' | 'skipped';
  };
  claude: { installed: boolean; usable: boolean };
  codex: { installed: boolean; usable: boolean };
  grok: { installed: boolean; usable: boolean };
}

const isCloudModel = (m: string): boolean => m.endsWith(':cloud') || m.endsWith('-cloud');

interface CliResult { code: number; stdout: string; stderr: string; }

/** Run a CLI with a timeout; optionally strip credentials to force subscription auth.
 *  Exported so the boot-time state migration in index.ts can probe `claude --version`
 *  asynchronously (a spawnSync there would block the whole event loop for up to 8s). */
export function runCli(
  command: string,
  args: string[],
  opts: { timeoutMs: number; input?: string; stripKeys?: 'anthropic' | 'openai' | 'xai'; cwd?: string } = { timeoutMs: 8000 },
): Promise<CliResult> {
  return new Promise(resolve => {
    const env = { ...process.env };
    // Mirror ClaudeCliProvider.buildChildEnv's SUBSCRIPTION branch exactly: the
    // claude-cli login probe is a real subscription completion, so it must clear
    // the same three vars — including ANTHROPIC_BASE_URL, or an ambient export
    // silently redirects the probe to a stray host (sending the subscription
    // credential there) and makes `usable` reflect the wrong backend, wrongly
    // dropping or admitting claude-cli members from auto-population. Like that
    // branch, the CLAUDE_CODE_USE_* backend selectors are intentionally NOT
    // cleared — a legitimately Bedrock/Vertex-hosted CLI must still probe usable.
    if (opts.stripKeys === 'anthropic') { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL; }
    if (opts.stripKeys === 'openai') { delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; }
    if (opts.stripKeys === 'xai') { delete env.XAI_API_KEY; }

    let child: ReturnType<typeof spawn>;
    try {
      // Own process group (like the real provider CLI invocations) so a
      // timeout reaps any subprocesses the probed CLI itself spawns, not just
      // the direct child — otherwise a hung probe can leave descendants
      // running after `council_status` gives up on it.
      // cwd: when set, pins the child's working directory so a probed CLI that
      // reads project-context files from its own cwd (AGENTS.md, .cursorrules, …)
      // finds nothing but an empty temp dir there — matching the real provider's
      // cwd pinning. Unset → inherits this server's cwd (the legacy default,
      // fine for `--version`/`login status` which read no project context).
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    } catch {
      resolve({ code: 127, stdout: '', stderr: 'spawn failed' });
      return;
    }
    const stdout = new CappedBuffer();
    const stderr = new CappedBuffer();
    let settled = false;
    const done = (r: CliResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };
    const timer = setTimeout(() => { killTree(); done({ code: 124, stdout: stdout.toString(), stderr: stderr.toString() }); }, opts.timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', d => stdout.append(d));
    child.stderr?.on('data', d => stderr.append(d));
    child.stdin?.on('error', () => {});
    child.on('error', () => done({ code: 127, stdout: stdout.toString(), stderr: stderr.toString() }));
    child.on('close', code => done({ code: code ?? 1, stdout: stdout.toString(), stderr: stderr.toString() }));
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

/**
 * Like withTimeout, but a timeout REJECTS instead of resolving with a
 * fallback — for callers where a timed-out result would otherwise be
 * indistinguishable from a genuine successful-but-empty result (e.g. a hung
 * Ollama host resolving `listModels()` to `[]` on timeout looks identical to
 * "reachable, zero models installed" unless the timeout case is a distinct
 * outcome the caller's try/catch can tell apart).
 */
export async function withTimeoutOrThrow<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
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
    const models = await withTimeoutOrThrow(ollama.listModels(), 6000);
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

async function detectClaude(tiers: SubscriptionTiers, subs: Subscriptions): Promise<EnvReport['claude']> {
  const cmd = cliPath('CLAUDE_CLI_PATH', 'claude');
  const installed = (await runCli(cmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  if (!installed) return { installed: false, usable: false };
  // The probe below is a REAL completion call — same class of real, billable
  // usage as grok's probe (see detectGrok's comment). Unlike grok, Claude
  // defaults to a paid tier, so in the common case this gate is a no-op —
  // but a user who's explicitly set CLAUDE_TIER=free (opting OUT of claude-cli
  // members) would otherwise still pay for a probe every council_status/boot,
  // for a result that gets thrown away anyway (autoPopulatedMembers already
  // requires tierAllowsCloud before including any claude-cli member).
  if (!tierAllowsCloud('claude', tiers.claude, subs)) {
    return { installed: true, usable: false };
  }
  // Lock the probe down exactly like the completion path: no tools, strict MCP
  // config (so it does NOT load — and recurse into — this very plugin), no
  // session persistence, and --safe-mode so an untrusted project-local
  // .claude/settings.json cannot execute hooks outside the tool-permission
  // system. Also pin cwd to an empty temp dir; otherwise the probe inherits the
  // MCP host's project directory and loads its setting sources.
  // Pin --model exactly like the completion path (claude-cli.ts) does. Without it
  // the probe inherits the CLI's configured default model for this directory — which
  // may be a non-Claude model (e.g. a local Ollama model set via /model), making a
  // perfectly logged-in CLI look "not usable". haiku is the cheapest always-valid alias.
  const probeDir = mkdtempSync(join(tmpdir(), 'claude-detect-cwd-'));
  let probe: CliResult;
  try {
    probe = await runCli(
      cmd,
      ['-p', 'Reply with the single word READY', '--model', 'haiku', '--output-format', 'text',
        '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--safe-mode'],
      { timeoutMs: 20000, stripKeys: 'anthropic', cwd: probeDir },
    );
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  return { installed: true, usable: probe.code === 0 && probe.stdout.trim().length > 0 };
}

async function detectCodex(): Promise<EnvReport['codex']> {
  const cmd = cliPath('CODEX_CLI_PATH', 'codex');
  const installed = (await runCli(cmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  if (!installed) return { installed: false, usable: false };
  // stripKeys: 'openai' — matches detectClaude/detectGrok's own probes, and
  // the real completion path (CodexCliProvider strips OPENAI_API_KEY/
  // CODEX_API_KEY before every real call). Without stripping here, an
  // OPENAI_API_KEY set in the environment can make `codex login status`
  // report "logged in" via API-key auth even without a genuine ChatGPT
  // subscription login — detection would then say usable while every real
  // completion call (which does strip the key) fails.
  const st = await runCli(cmd, ['login', 'status'], { timeoutMs: 8000, stripKeys: 'openai' });
  const out = `${st.stdout}\n${st.stderr}`;
  // NB: "Not logged in" contains "logged in" — must exclude it explicitly.
  const usable = /logged in/i.test(out) && !/not logged in/i.test(out);
  return { installed: true, usable };
}

async function detectGrok(tiers: SubscriptionTiers, subs: Subscriptions): Promise<EnvReport['grok']> {
  const cmd = cliPath('GROK_CLI_PATH', 'grok');
  const installed = (await runCli(cmd, ['--version'], { timeoutMs: 8000 })).code === 0;
  if (!installed) return { installed: false, usable: false };
  // grok-cli is DISABLED by default (src/providers/grok-cli.ts: its `--tools`
  // lockdown was proven not to work — both `--tools ''` and `--tools none`
  // leave the full built-in tool set enabled, and `--permission-mode
  // bypassPermissions` auto-approves every tool call, so any completion is an
  // arbitrary-command-execution surface). The provider's complete() refuses to
  // run unless GROK_CLI_UNSAFE_ACCEPT_RCE=true. The detection probe below is a
  // REAL completion call with that same argv shape, so it has the SAME RCE
  // surface — it must NOT run for a user who never opted into that risk.
  //
  // Round-17 finding (kimi): the probe previously gated on TIER alone (or the
  // legacy GROK_CLI=true), so a user who set a paid Grok tier got the RCE-argv
  // probe on every council_status/boot WITHOUT ever setting the RCE opt-in —
  // bypassing the disabled-provider mitigation at the detection path. The RCE
  // flag is now REQUIRED (a paid tier is a quota opt-in, NOT an RCE opt-in).
  //
  // The tier/GROK_CLI gate is KEPT as a SECOND, independent gate for the
  // separate quota concern: a free-tier user must not spend a real
  // quota-metered probe just by running council_status. BOTH gates must pass:
  //   - no RCE flag  → no probe (grok disabled, matching the provider).
  //   - RCE flag + free tier (and no GROK_CLI) → no probe (no quota opt-in).
  //   - RCE flag + paid tier (or GROK_CLI) → probe runs, cwd-pinned, --tools none.
  // This resolves the round-7 deferred ambiguity: the RCE flag is the single
  // gate for grok's RCE surface; the tier gate remains for the quota concern.
  const quotaOptIn = tierAllowsCloud('grok', tiers.grok, subs) || envBool('GROK_CLI', false);
  if (process.env.GROK_CLI_UNSAFE_ACCEPT_RCE !== 'true' || !quotaOptIn) {
    return { installed: true, usable: false };
  }
  // Both opt-ins present. Pin the probe's cwd to a fresh empty temp dir (like
  // the real provider) so the grok CLI does not inherit this server's project
  // cwd, where project-context files (AGENTS.md, .cursorrules, …) could steer
  // the model during the probe. Use `--tools none` to match the provider's
  // current argv (both shapes are RCE — the opt-in flag is the real mitigation,
  // not the --tools value — but consistency with the provider keeps the two
  // paths from drifting apart). bypassPermissions is required in headless mode
  // or the call silently cancels; subscription auth is forced by stripping
  // XAI_API_KEY.
  const probeDir = mkdtempSync(join(tmpdir(), 'grok-detect-cwd-'));
  let probe: CliResult;
  try {
    probe = await runCli(
      cmd,
      ['-p', 'Reply with the single word READY', '--output-format', 'json',
        '--tools', 'none', '--permission-mode', 'bypassPermissions'],
      { timeoutMs: 20000, stripKeys: 'xai', cwd: probeDir },
    );
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  if (probe.code !== 0) return { installed: true, usable: false };
  try {
    const parsed = JSON.parse(probe.stdout) as { text?: unknown; stopReason?: unknown };
    return { installed: true, usable: parsed.stopReason === 'EndTurn' && typeof parsed.text === 'string' && parsed.text.trim().length > 0 };
  } catch {
    return { installed: true, usable: false };
  }
}

/** Detect everything the council could use, given the resolved tiers. Probes run concurrently. */
export async function detectEnvironment(
  registry: ProviderRegistry,
  tiers: SubscriptionTiers,
  subs: Subscriptions,
): Promise<EnvReport> {
  const [ollama, claude, codex, grok] = await Promise.all([
    detectOllama(registry, tiers, subs),
    detectClaude(tiers, subs),
    detectCodex(),
    detectGrok(tiers, subs),
  ]);
  return { ollama, claude, codex, grok };
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
  /**
   * The registered servers, so each CLI provider contributes the models it was
   * ACTUALLY configured with. Without this the reference-data list is used
   * verbatim, so a user who narrowed a provider via CLAUDE_CLI_MODELS /
   * CODEX_CLI_MODELS / GROK_CLI_MODELS still had every catalogue model added —
   * silently re-adding paid members they had explicitly excluded. Optional so
   * existing callers/tests keep working (falls back to the reference data).
   */
  servers?: Array<{ type: string; models?: string[] }>,
): string[] {
  const configured = (type: string, fallback: string[] | undefined): string[] => {
    const s = servers?.find(x => x.type === type);
    return s?.models?.length ? s.models : (fallback ?? []);
  };
  const out: string[] = [];
  for (const m of report.ollama.localModels) out.push(`ollama:${m}`);
  if (report.ollama.cloud === 'ok') {
    // Route cloud models through the CC CLI harness (Read/Grep/Glob tool
    // access) when the claude binary is installed. This is a CC CLI plugin,
    // so the binary is expected. Fall back to bare Ollama otherwise.
    const useHarness = report.claude.installed;
    for (const m of subs.curatedCloudModels) {
      out.push(useHarness ? `claude-cli/claude-cli-ollama:${m}` : `ollama:${m}`);
    }
  }
  if (report.claude.usable && tierAllowsCloud('claude', tiers.claude, subs)) {
    for (const m of configured('claude-cli', subs.providers.claude.models)) out.push(`claude-cli:${m}`);
  }
  if (report.codex.usable && tierAllowsCloud('chatgpt', tiers.chatgpt, subs)) {
    for (const m of configured('codex-cli', subs.providers.chatgpt.models)) out.push(`codex-cli:${m}`);
  }
  if (report.grok.usable && tierAllowsCloud('grok', tiers.grok, subs)) {
    for (const m of configured('grok-cli', subs.providers.grok.models)) out.push(`grok-cli:${m}`);
  }
  return [...new Set(out)];
}

/**
 * State v1→v2: upgrade persisted bare-Ollama cloud labels to harness labels.
 * Pure function — the caller supplies the CLI-installed flag.
 */
export function migrateCloudToHarness(
  labels: string[],
  curatedCloudModels: string[],
  claudeInstalled: boolean,
): string[] {
  if (!claudeInstalled) return labels;
  const cloudSet = new Set(curatedCloudModels);
  if (!labels.some(l => l.startsWith('ollama:') && cloudSet.has(l.slice('ollama:'.length)))) {
    return labels;
  }
  const mapped = labels.map(l => {
    if (!l.startsWith('ollama:')) return l;
    const model = l.slice('ollama:'.length);
    return cloudSet.has(model) ? `claude-cli/claude-cli-ollama:${model}` : l;
  });
  // Dedup: if state already held BOTH a bare `ollama:X:cloud` and its migrated
  // `claude-cli/claude-cli-ollama:X:cloud` form (e.g. the user added the harness
  // version while the bare one still persisted), the map above would produce two
  // identical harness labels and the model would be queried twice. Drop dupes
  // preserving first-seen order — mirrors autoPopulatedMembers' own Set dedup.
  const seen = new Set<string>();
  return mapped.filter(l => (seen.has(l) ? false : (seen.add(l), true)));
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
  if (report.grok.usable && tierAllowsCloud('grok', tiers.grok, subs)) paid.push('Grok (X.AI) subscription');
  if (paid.length === 0) return null;
  return `The council includes ${paid.join(', ')} members — asking it consumes your ${paid.length > 1 ? 'quotas' : 'quota'}. ` +
    `Remove any you don't want with configure_council (or /model-council:setup) to reduce usage.`;
}
