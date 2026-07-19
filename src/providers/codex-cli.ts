/**
 * OpenAI via the first-party Codex CLI (`codex exec`).
 *
 * Analogous to the claude-cli provider: shells out to the locally-installed
 * `codex` binary so members run under the user's own ChatGPT subscription
 * (Sign in with ChatGPT / `codex login`) instead of a per-token API key. It is
 * the sanctioned first-party surface for subscription use; it is NOT the
 * (prohibited) reuse of a subscription token against the raw OpenAI API.
 *
 * The nested call is locked down: read-only sandbox (`--sandbox read-only`), no
 * approval prompts (`-c approval_policy=never`), an isolated empty working dir
 * (`-C <tmp>`), no session persistence (`--ephemeral`), no color codes, and the
 * final agent message captured via `-o <file>`. OPENAI_API_KEY / CODEX_API_KEY
 * are stripped from the child env so the ChatGPT subscription login is used.
 *
 * Note: Codex is a coding agent, so members answer with a coding-agent flavor.
 *
 * Vision (images): unlike claude-cli, `codex exec` has a first-party
 * `-i/--image <FILE>...` flag — no tool-loosening workaround needed. Each
 * attached image is written into the same per-call temp dir already used for
 * the isolated working directory, then passed via `-i`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatImage, ChatMessage, CompletionOptions, Provider } from './base.js';
import { ModelInfo, ProviderType, ServerConfig } from '../types.js';

const DEFAULT_MODELS = ['default'];
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

export class CodexCliProvider implements Provider {
  readonly serverId: string;
  readonly config: ServerConfig;
  private readonly command: string;
  private readonly models: string[];

  constructor(config: ServerConfig) {
    this.config = config;
    this.serverId = config.id;
    this.command = config.command?.trim() || 'codex';
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
      provider: 'codex-cli' as ProviderType,
      model: m,
      label: `Codex ${m} (ChatGPT subscription)`,
    }));
  }

  /** True: `codex exec` has a first-party `-i/--image` flag (see file header). */
  async supportsVision(): Promise<boolean> {
    return true;
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
    const convo = messages
      .filter(m => m.role !== 'system')
      .map(m => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
      .join('\n\n');

    // Codex has no system-prompt flag in exec mode; prepend a neutral persona.
    const preamble =
      'You are a member of a model council. Answer the question directly, ' +
      'neutrally, and concisely. Do not run commands or modify files — just answer.';
    const prompt = [
      preamble,
      systemParts,
      opts.jsonMode ? 'Respond with valid JSON only.' : '',
      convo,
    ]
      .filter(Boolean)
      .join('\n\n');

    // Run in a fresh empty dir with the final message written to a file, so the
    // agent has nothing to explore and we read a clean answer.
    const dir = mkdtempSync(join(tmpdir(), 'codex-council-'));
    const outFile = join(dir, 'out.txt');
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      '-c', 'approval_policy=never',
      '-C', dir,
      '-o', outFile,
    ];
    if (model && model !== 'default') {
      args.push('-m', model);
    }
    // Images are attached only on a user message; the orchestrator only routes
    // here at all when supportsVision() was confirmed for this member. Written
    // into the same per-call temp dir (cleaned up in the finally below).
    const images = messages.find(m => m.role === 'user' && m.images?.length)?.images ?? [];
    images.forEach((img, i) => {
      const path = join(dir, `image-${i}.${MIME_EXT[img.mimeType]}`);
      writeFileSync(path, Buffer.from(img.base64, 'base64'));
      args.push('-i', path);
    });

    try {
      // Codex is a slow reasoning agent; keep DEFAULT_TIMEOUT_MS as a floor so the
      // generic (shorter) request timeout can't cut off a valid answer, while a
      // higher REQUEST_TIMEOUT_MS can still raise it. Still bounded (no hang).
      const timeoutMs = Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
      const { code, stderr } = await this.run(args, prompt, timeoutMs);
      if (code !== 0) {
        throw new Error(
          `codex CLI exited with code ${code}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`,
        );
      }
      let out = '';
      try {
        out = readFileSync(outFile, 'utf8');
      } catch {
        out = '';
      }
      const trimmed = out.trim();
      if (!trimmed) {
        // Exit 0 but no final message written — surface the CLI's own stderr
        // diagnostic instead of a bare "empty response after retries".
        const detail = stderr.trim().slice(0, 300);
        throw new Error(
          `codex CLI produced no final message${detail ? `: ${detail}` : ' (empty output)'}`,
        );
      }
      return trimmed;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private run(
    args: string[],
    input: string | undefined,
    timeoutMs: number,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      // Force subscription auth: strip credentials so the ChatGPT login is used.
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;

      const child = spawn(this.command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so a timeout can reap codex-spawned sandbox
        // subprocesses (grandchildren), not just the direct child.
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        killTree(child);
        reject(new Error(`codex CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (stderr += d));
      child.stdin.on('error', () => {}); // swallow EPIPE on early child exit
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
