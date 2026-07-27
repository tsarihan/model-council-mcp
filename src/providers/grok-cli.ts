/**
 * X.AI's Grok via the first-party Grok Build CLI (`grok -p` / `--prompt-json`).
 *
 * Instead of calling X.AI's API with a per-token key, this provider shells out
 * to the locally-installed `grok` binary, so inference runs under whatever the
 * CLI is logged in with — typically the user's own SuperGrok / X Premium+
 * subscription. It is the sanctioned first-party surface for subscription use;
 * it is NOT the (prohibited) reuse of a subscription token against the raw API.
 *
 * The nested call is locked down: all tools disabled (`--tools ''`), no MCP
 * servers configured for this call, no session persistence needed (each call
 * is a fresh `-p`/`--prompt-json` single-turn), and — crucially —
 * XAI_API_KEY is stripped from the child environment, because the CLI accepts
 * it as an alternate auth path and would otherwise silently bill per-token
 * instead of using the subscription.
 *
 * Empirically required for headless use (verified live): `--permission-mode
 * bypassPermissions`. Without it, a call combining `--system-prompt-override`
 * with restricted tools silently returns `stopReason: "Cancelled"` and empty
 * text instead of completing — there is no TTY to satisfy whatever
 * confirmation step it's waiting on.
 *
 * Vision (images): unlike claude-cli, no workaround is needed — `--prompt-json`
 * accepts real ACP-style content blocks, including a native `image` block
 * (`{type:"image", data:<base64>, mimeType:"image/png"}`, bare base64, no
 * `data:` URI). This was verified against a real OCR-challenge image before
 * being wired in. Because the image is passed as structured content rather
 * than a file the model must go read, `--tools ''` (fully locked down) is
 * correct even for calls that include an image — no loosening required at all.
 *
 * Argv-length: `--prompt-json <JSON>` (and images/large context specifically)
 * is passed as a single argv element, unlike claude-cli/codex-cli which use
 * stdin/a temp file precisely to avoid OS argv-length limits (Linux
 * MAX_ARG_STRLEN ~128 KiB per argument, macOS ARG_MAX ~1 MiB total). For the
 * TEXT-ONLY case (no images) — the dominant one: any large `context`/`files`/
 * git diff, or a judge prompt embedding every member's response — this is now
 * routed through `--prompt-file <path>` (a temp file) instead, which grok's
 * own docs show used for plain-text prompt content (`grok --prompt-file
 * ./prompt.txt`), eliminating the argv-length risk for that path entirely.
 * Image-bearing calls still go through `--prompt-json` inline: there is no
 * documented file-based or stdin-based channel for grok's structured
 * content-block format (no `-i`/`--image` flag either, unlike codex-cli), so
 * this narrower exposure remains, bounded by the existing 8 MB/image, 24 MB
 * total caps. Whether `--prompt-file` ALSO accepts the `--prompt-json`
 * content-block shape (which would close this gap too) is UNVERIFIED against
 * the real CLI — investigation was blocked by the CLI's own quota
 * exhaustion; confirm live before relying on it.
 *
 * No MCP-recursion-prevention flag was found for this CLI (no `claude-cli`-style
 * `--strict-mcp-config` equivalent). Mitigated in practice by `--tools ''`
 * disabling all tool execution, and by `grok mcp` requiring an explicit,
 * deliberate `add` step — nothing is auto-discovered from project files the
 * way Claude Code's `.mcp.json` is.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CappedBuffer, ChatImage, ChatMessage, CompletionOptions, Provider , neutralizeFileMentions } from './base.js';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { CHALLENGE_PROMPT, verifyVisionChallenge } from '../vision-challenge.js';

const DEFAULT_MODELS = ['grok-4.5'];
const DEFAULT_TIMEOUT_MS = 300_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: ChatImage['mimeType'] };

/** SIGKILL the child's whole process group (detached), falling back to the child alone. */
function killTree(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export class GrokCliProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private readonly command: string;
  private readonly models: string[];
  /** Per-model OCR-challenge-verified vision result; only set once definitive. */
  private visionVerifiedCache = new Map<string, boolean>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.command = config.command?.trim() || 'grok';
    this.models =
      config.models && config.models.length ? config.models : DEFAULT_MODELS;
  }

  async ping(): Promise<boolean> {
    try {
      const { code } = await this.run(['--version'], undefined, 8000);
      return code === 0;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map(m => ({
      provider: 'grok-cli' as ProviderType,
      model: m,
      label: `Grok ${m} (subscription)`,
    }));
  }

  /**
   * There's no cheap capability signal for a CLI subprocess (no metadata
   * endpoint, no accept/reject probe), so this goes straight to the OCR
   * challenge — a real subprocess call once per model, cached after. Grok-4.5
   * is genuinely vision-capable and `complete()`'s native `image` content
   * block should always resolve true — but it stays a real behavioral check
   * rather than a hardcoded assumption, consistent with every other provider.
   */
  async supportsVision(model: string): Promise<boolean> {
    const cached = this.visionVerifiedCache.get(model);
    if (cached !== undefined) return cached;

    const outcome = await verifyVisionChallenge((challenge) =>
      this.complete(
        model,
        [{ role: 'user', content: CHALLENGE_PROMPT, images: [{ base64: challenge.base64, mimeType: challenge.mimeType }] }],
        { maxTokens: 2000, timeoutMs: 60_000 },
      ),
    );
    if (outcome === 'pass') { this.visionVerifiedCache.set(model, true); return true; }
    if (outcome === 'fail') { this.visionVerifiedCache.set(model, false); return false; }
    return false; // inconclusive — not cached, retried next call
  }

  getVisionCache(): Record<string, boolean> {
    return Object.fromEntries(this.visionVerifiedCache);
  }

  seedVisionCache(entries: Record<string, boolean>): void {
    for (const [model, vision] of Object.entries(entries)) {
      if (!this.visionVerifiedCache.has(model)) this.visionVerifiedCache.set(model, vision);
    }
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    opts: CompletionOptions = {},
  ): Promise<string> {
    const systemParts = messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');

    // Images are attached only on a user message; the orchestrator only routes
    // here at all when supportsVision() was confirmed for this member.
    const images = messages.find(m => m.role === 'user' && m.images?.length)?.images ?? [];

    // Flatten the conversation into one text block, then append native image
    // blocks — no temp files, no tool loosening (see file header).
    const convo = messages
      .filter(m => m.role !== 'system')
      .map(m => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
      .join('\n\n');

    // Replace the CLI's default coding-agent persona with a neutral
    // council-member one, matching claude-cli/codex-cli's treatment.
    const base =
      'You are a member of a model council. Answer the question directly, ' +
      'neutrally, and concisely. Do not use tools or ask follow-up questions.';
    const systemText = [
      base,
      systemParts,
      opts.jsonMode ? 'Respond with valid JSON only.' : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // Created INSIDE the try so the finally's rmSync always cleans up even if
    // the writeFileSync below throws after mkdtempSync succeeded.
    let promptDir: string | undefined;
    // An EMPTY directory to run the child in, so it never inherits the server's
    // own cwd as implicit project context (see run()'s cwd note).
    let runDir: string | undefined;
    try {
      runDir = mkdtempSync(join(tmpdir(), 'grok-council-cwd-'));
      // No images: write the (possibly large) flattened text prompt to a temp
      // file and pass --prompt-file, avoiding the argv-length limit entirely
      // for this — the dominant — case. With images: no documented file-based
      // channel exists for the structured content-block format, so
      // --prompt-json stays inline (see file header for the residual risk).
      let promptArgs: string[];
      if (images.length === 0) {
        promptDir = mkdtempSync(join(tmpdir(), 'grok-council-prompt-'));
        const promptFile = join(promptDir, 'prompt.txt');
        writeFileSync(promptFile, neutralizeFileMentions(convo), 'utf8');
        promptArgs = ['--prompt-file', promptFile];
      } else {
        const blocks: ContentBlock[] = [
          { type: 'text', text: neutralizeFileMentions(convo) },
          ...images.map(img => ({ type: 'image' as const, data: img.base64, mimeType: img.mimeType })),
        ];
        promptArgs = ['--prompt-json', JSON.stringify(blocks)];
      }

      const args = [
        '-m', model,
        '--output-format', 'json',
        ...promptArgs,
        '--verbatim', // send the prompt EXACTLY as given: without this, grok expands
                      // @path mentions client-side, bypassing the --tools '' lockdown
        '--tools', '', // fully locked down — native image blocks need no tool access
        '--permission-mode', 'bypassPermissions', // required in headless mode, see file header
        '--system-prompt-override', systemText,
      ];

      // Respect an explicit opts.timeoutMs verbatim (matches every other
      // provider's plain `?? DEFAULT` pattern) — a Math.max floor here used to
      // silently override a DELIBERATELY short explicit timeout (e.g.
      // supportsVision()'s 60s probe budget always became 300s), defeating the
      // caller's own choice. A caller that wants the DEFAULT_TIMEOUT_MS floor
      // for a slow reasoning model still gets it by omitting timeoutMs; a
      // caller with a genuinely low REQUEST_TIMEOUT_MS now correctly has that
      // honoured here too, consistent with API providers.
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { code, stdout, stderr } = await this.run(args, undefined, timeoutMs, runDir);
      if (code !== 0) {
        throw new Error(
          `grok CLI exited with code ${code}: ${stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || '(no output)'}`,
        );
      }

      let parsed: { text?: unknown; stopReason?: unknown; type?: unknown; message?: unknown };
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(
          `grok CLI returned non-JSON output: ${stdout.trim().slice(0, 300)}`,
        );
      }
      // Error shape: {"type":"error","message":"..."} — exit code can still be 1
      // for this (already handled above), but guard the shape defensively too.
      if (parsed.type === 'error') {
        throw new Error(`grok CLI reported an error: ${String(parsed.message ?? '(no detail)').slice(0, 300)}`);
      }
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      // An abnormal stopReason means the turn did NOT finish — 'Cancelled' (the
      // documented headless failure mode), a max-tokens stop, or a refusal. The
      // old guard only fired when the text was ALSO empty, so a partial answer
      // from a cancelled/truncated turn was returned as if it were complete,
      // silently feeding a truncated position into the council.
      if (parsed.stopReason !== 'EndTurn') {
        throw new Error(`grok CLI did not complete the turn (stopReason: ${String(parsed.stopReason)})`);
      }
      return text;
    } finally {
      if (runDir) {
        try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (promptDir) {
        try {
          rmSync(promptDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  private run(
    args: string[],
    input: string | undefined,
    timeoutMs: number,
    cwd?: string,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // Force subscription auth: the CLI accepts XAI_API_KEY as an alternate
      // auth path, which would silently switch billing to per-token instead
      // of the subscription — strip it.
      const env = { ...process.env };
      delete env.XAI_API_KEY;

      const child = spawn(this.command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so a timeout reaps any subprocesses grok spawns.
        detached: true,
        // Explicit cwd (see complete()): without it the child inherits the
        // SERVER's working directory — for a Claude Code plugin, the user's own
        // project — and grok loads that directory's project context (AGENTS.md,
        // Cursor/Claude rules) into every member. That silently contaminates a
        // council member's answer with unrelated project instructions, and is the
        // same class of implicit-scope leak that was fixed for claude-cli.
        ...(cwd ? { cwd } : {}),
      });

      const stdout = new CappedBuffer();
      const stderr = new CappedBuffer();
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        killTree(child);
        reject(new Error(`grok CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // setEncoding decodes multi-byte UTF-8 across chunk boundaries correctly.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => stdout.append(d));
      child.stderr.on('data', d => stderr.append(d));
      // Swallow stdin EPIPE: if the child exits before draining stdin, the pipe
      // errors asynchronously; with no listener Node escalates it to an uncaught
      // exception that would kill the whole server. close/error still settle us.
      child.stdin.on('error', () => {});
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: stdout.toString(), stderr: stderr.toString() });
      });

      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  }
}
