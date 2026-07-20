/**
 * Anthropic via the first-party Claude Code CLI (`claude -p`).
 *
 * Instead of calling the Anthropic API with a per-token API key, this provider
 * shells out to the locally-installed `claude` binary, so inference runs under
 * whatever the CLI is logged in with — typically the user's own Claude Pro/Max
 * subscription. It is the sanctioned first-party surface for subscription use;
 * it is NOT the (prohibited) reuse of a subscription OAuth token against the raw
 * API.
 *
 * The nested call is locked down: all tools are disabled by default (`--tools
 * ""`), MCP is restricted (`--strict-mcp-config` with no config, avoiding
 * recursion back into this plugin), sessions aren't persisted, and —
 * crucially — ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are stripped from the
 * child environment, because the CLI silently prefers an API key over the
 * subscription when one is present.
 *
 * Vision (images): the CLI has no `--image` flag, so an attached image is
 * written to a fresh, uniquely-named temp directory and the invocation is
 * loosened for THAT CALL ONLY to `--tools Read --add-dir <thatTempDir>` — the
 * single narrowest tool needed to view a file, scoped to a directory
 * containing nothing but the image(s). `--add-dir` is an enforced permission
 * boundary, not advisory: a Read attempt outside the granted directory is
 * denied by the CLI itself (verified empirically — it surfaces as a
 * `permission_denials` entry, not a refusal the model could talk itself out
 * of). Every other property of the lockdown (no MCP, no other tools, no
 * session persistence) is unchanged. Calls with no images keep the original
 * `--tools ""` — nothing is loosened unless there's an image to show it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatImage, ChatMessage, CompletionOptions, Provider } from './base.js';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';
import { CHALLENGE_PROMPT, verifyVisionChallenge } from '../vision-challenge.js';

const DEFAULT_MODELS = ['opus', 'sonnet'];
const DEFAULT_TIMEOUT_MS = 300_000;

const MIME_EXT: Record<ChatImage['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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

export class ClaudeCliProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private readonly command: string;
  private readonly models: string[];
  /** Per-model OCR-challenge-verified vision result; only set once definitive. */
  private visionVerifiedCache = new Map<string, boolean>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.command = config.command?.trim() || 'claude';
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
      provider: 'claude-cli' as ProviderType,
      model: m,
      label: `Claude ${m} (subscription)`,
    }));
  }

  /**
   * There's no cheap capability signal for a CLI subprocess (no metadata
   * endpoint, no accept/reject probe), so this goes straight to the OCR
   * challenge — a real subprocess call once per model, cached after. The
   * underlying Claude models are vision-capable and `complete()` gives the
   * CLI a real (permission-enforced) way to view an attached image (see the
   * file header), so this should always resolve true — but it stays a real
   * behavioral check rather than a hardcoded assumption, consistent with
   * every other provider and correct if the mechanism ever regresses.
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
    let imageDir: string | undefined;
    let imagePaths: string[] = [];
    if (images.length > 0) {
      imageDir = mkdtempSync(join(tmpdir(), 'claude-council-img-'));
      imagePaths = images.map((img, i) => {
        const path = join(imageDir!, `image-${i}.${MIME_EXT[img.mimeType]}`);
        writeFileSync(path, Buffer.from(img.base64, 'base64'));
        return path;
      });
    }

    try {
      // Flatten the conversation into a single prompt (passed via stdin to avoid
      // argv length limits on large judge prompts). When images are attached,
      // append an explicit instruction naming their paths — the model has no
      // other way to know they exist.
      const imageNote = imagePaths.length
        ? `\n\n(${imagePaths.length} image(s) are attached. Read each one with the ` +
          `Read tool before answering: ${imagePaths.join(', ')})`
        : '';
      const prompt = messages
        .filter(m => m.role !== 'system')
        .map(m => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
        .join('\n\n') + imageNote;

      // Replace Claude Code's default (coding-agent) system prompt with a neutral
      // council-member persona so `claude-cli:*` members behave like a plain model
      // — matching the `anthropic:*` API provider rather than the CLI's harness.
      const base =
        'You are a member of a model council. Answer the question directly, ' +
        'neutrally, and concisely. ' +
        (imagePaths.length
          ? 'Use the Read tool only to view the attached image(s); do not use it for anything else, and do not ask follow-up questions.'
          : 'Do not use tools or ask follow-up questions.');
      const systemText = [
        base,
        systemParts,
        opts.jsonMode ? 'Respond with valid JSON only.' : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const args = [
        '-p',
        '--model', model,
        '--output-format', 'json',
        // No images: fully locked down (no tools at all). With images: the
        // single narrowest tool needed (Read), scoped to a directory holding
        // nothing but the image(s) — see the file header for why this is safe.
        '--tools', imagePaths.length ? 'Read' : '',
        ...(imageDir ? ['--add-dir', imageDir] : []),
        '--strict-mcp-config',    // no MCP servers (no recursion into this plugin)
        '--no-session-persistence',
        '--system-prompt', systemText, // replace the default coding-agent persona
      ];

      // CLI reasoning agents are legitimately slow; keep DEFAULT_TIMEOUT_MS as a
      // floor so the (shorter) generic request timeout can't cut off a valid answer,
      // while a higher REQUEST_TIMEOUT_MS can still raise it. Still bounded (no hang).
      const timeoutMs = Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
      const { code, stdout, stderr } = await this.run(args, prompt, timeoutMs);
      if (code !== 0) {
        throw new Error(
          `claude CLI exited with code ${code}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
        );
      }

      let parsed: { result?: unknown; is_error?: unknown };
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(
          `claude CLI returned non-JSON output: ${stdout.trim().slice(0, 300)}`,
        );
      }
      const result = typeof parsed.result === 'string' ? parsed.result : '';
      // The CLI can report failures (rate limit, max turns) with exit 0 + is_error.
      if (parsed.is_error === true) {
        throw new Error(
          `claude CLI reported an error: ${result.slice(0, 300) || '(no detail)'}`,
        );
      }
      return result;
    } finally {
      if (imageDir) {
        try {
          rmSync(imageDir, { recursive: true, force: true });
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
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // Force subscription auth: strip credentials the CLI would prefer over it.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = spawn(this.command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so a timeout reaps any subprocesses claude spawns,
        // not just the direct child.
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        killTree(child);
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // setEncoding decodes multi-byte UTF-8 across chunk boundaries correctly.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (stderr += d));
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
        resolve({ code: code ?? 1, stdout, stderr });
      });

      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  }
}
