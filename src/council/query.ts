/**
 * Shared member-query machinery: bounded-concurrency fan-out and
 * retry-on-empty completion.
 */
import { ChatImage, ChatMessage, CompletionOptions, Provider, isTimeoutError, isQuotaError, QuotaExceededError, PromptTooLargeError } from '../providers/base.js';
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
    case 'claude-cli': {
      // An Ollama-harness claude-cli server (config.anthropicBaseUrl set —
      // see claude-cli.ts's file header) is driving Ollama, not the real
      // Claude subscription: it must respect OLLAMA's concurrency ceiling,
      // not the unrelated Claude subscription tier's limit. Read the TRIMMED
      // value so this agrees with buildChildEnv/the constructor (both treat a
      // whitespace-only anthropicBaseUrl as absent) — otherwise the pool and
      // the actual backend could disagree for a whitespace-only config value.
      if (m.provider.config.anthropicBaseUrl?.trim()) {
        const model = m.modelId.model;
        return model.endsWith(':cloud') || model.endsWith('-cloud') ? 'ollama-cloud' : 'local';
      }
      return 'claude';
    }
    case 'grok-cli': return 'grok';
    case 'openai': return 'openai';
    case 'anthropic': return 'anthropic';
    case 'xai': return 'xai';
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
    [...buckets.entries()].map(([key, tasks]) => pooled(key, tasks, limitForPool(key, runtime))),
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

/**
 * A counting semaphore, one per pool key, held at MODULE scope (see
 * `semaphores` below) so the concurrency ceiling is enforced across the whole
 * process — not just within one `queryMembersVarying`/`checkVisionPooled`
 * call. Two concurrent `ask_council` calls that both touch e.g. the `claude`
 * pool must never together exceed that pool's limit; a per-call-only pool
 * (the previous design) couldn't see the other call's in-flight requests.
 *
 * `acquire`'s limit is passed per call (not fixed at construction) since it's
 * derived from `RuntimeConfig`, which a caller could in principle vary
 * between calls (e.g. a tier change mid-session) — each waiter re-checks
 * against whatever limit it was given when woken.
 */
export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(limit: number): Promise<void> {
    if (!(limit > 0)) {
      // Unlimited (limit <= 0 or NaN) — never blocks.
      this.inFlight++;
      return;
    }
    while (this.inFlight >= limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.inFlight++;
  }

  /** Must be called exactly once per successful acquire(), even on failure — see callers' try/finally. */
  release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const semaphores = new Map<PoolKey, Semaphore>();

function semaphoreFor(key: PoolKey): Semaphore {
  let s = semaphores.get(key);
  if (!s) {
    s = new Semaphore();
    semaphores.set(key, s);
  }
  return s;
}

/**
 * Run every task, admitting at most `limit` concurrently into pool `key` —
 * gated by that pool's process-wide semaphore, not a fresh per-call worker
 * pool, so the ceiling holds across concurrently in-flight `ask_council`
 * calls sharing the same provider. `limit <= 0` means unlimited.
 */
export async function pooled(key: PoolKey, tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  const sem = semaphoreFor(key);
  await Promise.all(
    tasks.map(async task => {
      await sem.acquire(limit);
      try {
        await task();
      } finally {
        sem.release();
      }
    }),
  );
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
      // A too-large prompt is likewise not going to change between attempts.
      // A quota/rate-limit refusal will not change between attempts either —
      // retrying just burns more of an already-exhausted plan and adds backoff
      // delay per member, per round. Normalize it so the caller sees plainly
      // that this member was refused for quota, not that it produced a bad answer.
      if (isQuotaError(err)) {
        lastErr = new QuotaExceededError(
          `quota/rate limit reached for ${model}: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
        );
        break;
      }
      if (isTimeoutError(err) || err instanceof PromptTooLargeError) break;
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Like completeWithRetry, but admitted through the SAME process-wide
 * semaphore as member fan-out (see `pooled`/`Semaphore` above). Judge calls
 * (categorize/poolResponses/buildProsCons/synthesize) previously called
 * completeWithRetry directly, bypassing the pool entirely — two concurrent
 * ask_council calls whose judges shared a tightly-limited provider (e.g.
 * `claude` at tier `pro`, limit 2) could together spawn far more concurrent
 * judge subprocesses/requests than that provider's ceiling allows, exactly
 * the gap the process-wide semaphore exists to close. Safe from deadlock: a
 * judge call always runs AFTER its round's member fan-out has fully
 * completed (queryMembers's Promise.all resolves, releasing every member
 * slot, before a judge call is ever made) — no caller holds a slot in this
 * pool while trying to acquire another in the same pool.
 */
export async function pooledComplete(
  judge: Member,
  messages: ChatMessage[],
  opts: CompletionOptions,
  retries: number,
  runtime: RuntimeConfig,
): Promise<string> {
  const key = poolKey(judge);
  let result = '';
  let error: unknown;
  let threw = false;
  await pooled(
    key,
    [
      async () => {
        try {
          result = await completeWithRetry(judge.provider, judge.modelId.model, messages, opts, retries);
        } catch (err) {
          error = err;
          threw = true;
        }
      },
    ],
    limitForPool(key, runtime),
  );
  if (threw) throw error;
  return result;
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
          {
            maxTokens: runtime.maxTokens,
            timeoutMs: runtime.requestTimeoutMs,
            fullRepoAccess: runtime.fullRepoAccess,
            // Council-wide reasoning depth. Set here rather than at each call
            // site so EVERY member round inherits it — the initial fan-out,
            // every deconfliction round, and the pooled/dialectic re-asks.
            effort: runtime.reasoningEffort,
            ...opts,
          },
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
    [...buckets.entries()].map(([key, tasks]) => pooled(key, tasks, limitForPool(key, runtime))),
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
