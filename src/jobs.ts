/**
 * In-memory store for background council runs (`ask_council_async`).
 *
 * The MCP server is a single long-lived process, so a fire-and-forget promise
 * plus a capped Map is enough: start a job, return its id immediately, and let
 * the caller poll `get_council_result`. Jobs do NOT survive a server restart —
 * a `/reload-plugins` drops them, which is fine for the "run it while I keep
 * working" use case. The cap bounds memory on a chatty session.
 */
import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'error';

export interface Job {
  id: string;
  status: JobStatus;
  question: string; // truncated for the listing
  mode?: string;
  memberCount?: number;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}

const MAX_JOBS = 50;
const QUESTION_PREVIEW = 200;

// evict() only ever drops FINISHED jobs (by design — a running job's result
// would otherwise be lost). That leaves running jobs with no ceiling at all:
// every ask_council_async call starts immediately and launches its own full
// council fan-out, so an unbounded number of concurrent calls could queue an
// unbounded number of concurrent fan-outs (independent of, and on top of,
// query.ts's own per-provider concurrency pools). Cap admission instead of
// trying to cap something already in flight.
const MAX_RUNNING_JOBS = 20;

export class JobStore {
  private jobs = new Map<string, Job>();

  /** Register a running job and return its record (id is a UUID). Throws if too many jobs are already running. */
  start(question: string, meta: { mode?: string; memberCount?: number }): Job {
    const running = [...this.jobs.values()].filter(j => j.status === 'running').length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new Error(
        `Too many background council runs in flight (${running}/${MAX_RUNNING_JOBS}). ` +
          `Wait for one to finish (get_council_result) before starting another.`,
      );
    }
    const job: Job = {
      id: randomUUID(),
      status: 'running',
      question: question.slice(0, QUESTION_PREVIEW),
      mode: meta.mode,
      memberCount: meta.memberCount,
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.evict();
    return job;
  }

  finish(id: string, result: unknown): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.result = result;
    job.finishedAt = Date.now();
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.error = error;
    job.finishedAt = Date.now();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Recent jobs, newest first (metadata only — no result payloads). */
  list(): Array<Omit<Job, 'result'>> {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ result, ...meta }) => meta);
  }

  /** Drop the oldest finished jobs once over the cap (keep running ones). */
  private evict(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const removable = [...this.jobs.values()]
      .filter(j => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size > MAX_JOBS && removable.length) {
      this.jobs.delete(removable.shift()!.id);
    }
  }
}
