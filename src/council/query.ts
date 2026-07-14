/**
 * Shared member-query machinery: bounded-concurrency fan-out and
 * retry-on-empty completion.
 */
import { ChatMessage, CompletionOptions, Provider } from '../providers/base.js';
import { ModelId, RawResponse, RuntimeConfig } from '../types.js';
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
  const type = m.provider.config.type;
  if (type === 'openai' || type === 'anthropic' || type === 'groq' || type === 'claude-cli' || type === 'codex-cli') return true;
  const model = m.modelId.model;
  return model.endsWith(':cloud') || model.endsWith('-cloud');
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
    }
    if (attempt < attempts) await sleep(400 * attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Query every member with the same prompt, honouring separate cloud/local
 * concurrency limits. Results preserve member order; a member that fails after
 * all retries is recorded with an `error` and empty response rather than
 * throwing.
 */
export async function queryMembers(
  question: string,
  members: Member[],
  runtime: RuntimeConfig,
  opts: CompletionOptions = {},
): Promise<RawResponse[]> {
  const results: RawResponse[] = new Array(members.length);
  const cloudTasks: Array<() => Promise<void>> = [];
  const localTasks: Array<() => Promise<void>> = [];

  members.forEach((member, i) => {
    const task = async () => {
      const label = modelIdLabel(member.modelId);
      const t0 = Date.now();
      try {
        const response = await completeWithRetry(
          member.provider,
          member.modelId.model,
          [{ role: 'user', content: question }],
          { maxTokens: runtime.maxTokens, ...opts },
          runtime.retries,
        );
        results[i] = { modelId: member.modelId, label, response, latencyMs: Date.now() - t0 };
      } catch (err) {
        results[i] = {
          modelId: member.modelId,
          label,
          response: '',
          error: String(err),
          latencyMs: Date.now() - t0,
        };
      }
    };
    (isCloudMember(member) ? cloudTasks : localTasks).push(task);
  });

  await Promise.all([
    pooled(cloudTasks, runtime.cloudConcurrency),
    pooled(localTasks, runtime.localConcurrency),
  ]);

  return results;
}
