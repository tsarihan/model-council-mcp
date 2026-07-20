/**
 * Shared member-query machinery: bounded-concurrency fan-out and
 * retry-on-empty completion.
 */
import { ChatImage, ChatMessage, CompletionOptions, Provider, isTimeoutError } from '../providers/base.js';
import { ModelId, PoolKey, RawResponse, RuntimeConfig } from '../types.js';
import { modelIdLabel } from '../config.js';

export interface Member {
  modelId: ModelId;
  provider: Provider;
}

/**
 * A member counts as "cloud" (subject to hosted concurrency limits) when it is
 * an external cloud API or an Ollama cloud model. Everything else (local
 * Ollama, self-hosted vLLM/TRT-LLM/SGLang) is treated as local.
 *
 * Ollama cloud model tags end with `cloud`: either bare `model:cloud`
 * (e.g. `glm-5.2:cloud`) or size-tagged `model:<size>-cloud`
 * (e.g. `qwen3-coder:480b-cloud`, `mistral-large-3:675b-cloud`).
 */
export function isCloudMember(m: Member): boolean {
  return poolKey(m) !== 'local';
}

/**
 * The concurrency pool a member belongs to. Each subscription gets its own
 * ceiling so a slow, tightly-limited provider can't starve another. `local`
 * covers local Ollama and self-hosted vLLM/TRT-LLM/SGLang.
 */
export function poolKey(m: Member): PoolKey {
  const type = m.provider.config.type;
  switch (type) {
    case 'codex-cli': return 'chatgpt';
    case 'claude-cli': return 'claude';
    case 'openai': return 'openai';
    case 'anthropic': return 'anthropic';
    case 'groq': return 'groq';
    case 'ollama': {
      const model = m.modelId.model;
      return model.endsWith(':cloud') || model.endsWith('-cloud') ? 'ollama-cloud' : 'local';
    }
    default:
      return 'local'; // vllm / trtllm / sglang — self-hosted
  }
}

/** Effective concurrency limit for a pool, with back-compat fallbacks. */
function limitForPool(key: PoolKey, runtime: RuntimeConfig): number {
  const explicit = runtime.poolLimits?.[key];
  if (explicit !== undefined) return explicit;
  return key === 'local' ? runtime.localConcurrency : runtime.cloudConcurrency;
}

export interface VisionCheck {
  member: Member;
  vision: boolean;
}

/**
 * A human-readable status line for a long-running fan-out, so a caller that
 * can forward it (e.g. an MCP `notifications/progress`) keeps the user from
 * thinking a slow call has hung — vision detection in particular can now take
 * minutes on a machine with several large local models, since it's correctly
 * serialized per provider rather than racing them concurrently.
 */
export type ProgressReporter = (message: string) => void | Promise<void>;

/**
 * Probe every member's supportsVision(), honouring the SAME per-provider
 * concurrency limits as a real query round (notably `local`, typically 1). A
 * vision probe is a real completion call — the OCR-challenge round trip, not
 * just a metadata read — so firing every member's probe concurrently against
 * a single local Ollama host can thrash memory on hardware that can't hold
 * multiple large local models at once, causing genuinely vision-capable
 * models to time out and be (transiently) misreported as not vision-capable.
 */
export async function checkVisionPooled(
  members: Member[],
  runtime: RuntimeConfig,
  onProgress?: ProgressReporter,
): Promise<VisionCheck[]> {
  const results: VisionCheck[] = new Array(members.length);
  const buckets = new Map<PoolKey, Array<() => Promise<void>>>();
  const total = members.length;
  let done = 0;

  members.forEach((member, i) => {
    const task = async () => {
      const label = modelIdLabel(member.modelId);
      await onProgress?.(`Checking vision capability: ${label} (${done + 1}/${total})`);
      const vision = await member.provider.supportsVision(member.modelId.model).catch(() => false);
      done++;
      await onProgress?.(`${label}: ${vision ? 'vision-capable' : 'not vision-capable'} (${done}/${total} checked)`);
      results[i] = { member, vision };
    };
    const key = poolKey(member);
    const arr = buckets.get(key);
    if (arr) arr.push(task);
    else buckets.set(key, [task]);
  });

  await Promise.all(
    [...buckets.entries()].map(([key, tasks]) => pooled(tasks, limitForPool(key, runtime))),
  );

  return results;
}

/** Thrown by completeWithRetry when every attempt returned an empty response. */
export class EmptyCompletionError extends Error {
  constructor(message = 'empty response after retries') {
    super(message);
    this.name = 'EmptyCompletionError';
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Run thunks with at most `limit` in flight (limit <= 0 → unlimited). */
async function pooled(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  const width = limit && limit > 0 ? Math.min(limit, tasks.length) : tasks.length;
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

/**
 * Call provider.complete, retrying on a thrown error or an empty response.
 * Gives up after `retries` attempts and rethrows the last error.
 */
export async function completeWithRetry(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  opts: CompletionOptions,
  retries: number,
): Promise<string> {
  const attempts = Math.max(1, retries);
  let lastErr: unknown = new Error('completion failed');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await provider.complete(model, messages, opts);
      if (res && res.trim() !== '') return res;
      lastErr = new EmptyCompletionError();
    } catch (err) {
      lastErr = err;
      // A timeout means the server/subprocess is unresponsive; retrying just
      // multiplies the wall-clock wait (and rarely succeeds), so give up now.
      if (isTimeoutError(err)) break;
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Query every member, building each member's prompt via `promptFor` (so
 * different members can receive personalised prompts), honouring separate
 * cloud/local concurrency limits. Results preserve member order; a member that
 * fails after all retries is recorded with an `error` and empty response rather
 * than throwing.
 */
export async function queryMembersVarying(
  promptFor: (member: Member, index: number) => string,
  members: Member[],
  runtime: RuntimeConfig,
  opts: CompletionOptions = {},
  images?: ChatImage[],
  onProgress?: ProgressReporter,
): Promise<RawResponse[]> {
  const results: RawResponse[] = new Array(members.length);
  // Group tasks into per-provider pools so each subscription's concurrency
  // ceiling is honoured independently (ChatGPT 6, Ollama cloud 3/10, …).
  const buckets = new Map<PoolKey, Array<() => Promise<void>>>();
  const total = members.length;
  let done = 0;

  members.forEach((member, i) => {
    const task = async () => {
      const label = modelIdLabel(member.modelId);
      await onProgress?.(`Asking ${label}...`);
      const t0 = Date.now();
      try {
        const userMessage: ChatMessage = {
          role: 'user',
          content: promptFor(member, i),
          ...(images?.length ? { images } : {}),
        };
        const response = await completeWithRetry(
          member.provider,
          member.modelId.model,
          [userMessage],
          { maxTokens: runtime.maxTokens, timeoutMs: runtime.requestTimeoutMs, ...opts },
          runtime.retries,
        );
        results[i] = { modelId: member.modelId, label, response, latencyMs: Date.now() - t0 };
        done++;
        await onProgress?.(`${label} answered (${done}/${total})`);
      } catch (err) {
        results[i] = {
          modelId: member.modelId,
          label,
          response: '',
          error: String(err),
          latencyMs: Date.now() - t0,
        };
        done++;
        await onProgress?.(`${label} failed (${done}/${total})`);
      }
    };
    const key = poolKey(member);
    const arr = buckets.get(key);
    if (arr) arr.push(task);
    else buckets.set(key, [task]);
  });

  await Promise.all(
    [...buckets.entries()].map(([key, tasks]) => pooled(tasks, limitForPool(key, runtime))),
  );

  return results;
}

/**
 * Query every member with the SAME prompt, honouring separate cloud/local
 * concurrency limits. Results preserve member order; a member that fails after
 * all retries is recorded with an `error` and empty response rather than
 * throwing.
 */
export async function queryMembers(
  question: string,
  members: Member[],
  runtime: RuntimeConfig,
  opts: CompletionOptions = {},
  images?: ChatImage[],
  onProgress?: ProgressReporter,
): Promise<RawResponse[]> {
  return queryMembersVarying(() => question, members, runtime, opts, images, onProgress);
}
