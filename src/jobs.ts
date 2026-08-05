/**
 * Store for background council runs (`ask_council_async`), persisted to disk.
 *
 * The MCP server is a single long-lived process, so a fire-and-forget promise
 * plus a capped Map does the running; each job is ALSO mirrored to
 * `<state file>.jobs/<id>.json` so a `/reload-plugins` no longer silently
 * eats a finished result the user had not fetched yet — the most expensive
 * runs (long deconflictions, web research) are exactly the ones people
 * background and come back to after a reload.
 *
 * Honest limit: a job that was still RUNNING when the process died cannot be
 * resumed — its subprocesses and requests died with the server. On boot such
 * a job is loaded as `error: interrupted…` rather than left `running`
 * forever, so a poller gets a clear terminal answer instead of a hang.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { statePath } from './state.js';

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
/** Newest persisted jobs kept on disk; older files are pruned. */
const MAX_PERSISTED = 20;
/** A result bigger than this is kept in memory but not mirrored to disk. */
const MAX_PERSISTED_RESULT_BYTES = 2 * 1024 * 1024;

/** Sibling directory named after the state FILE, so isolated state files (tests, MODEL_COUNCIL_STATE overrides) get isolated job stores too. */
function jobsDir(): string {
  return `${statePath()}.jobs`;
}

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

  constructor() {
    // Load what a previous process left behind. Best-effort throughout: a
    // corrupt or unreadable jobs dir must never stop the server booting.
    try {
      const dir = jobsDir();
      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const job = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Job;
          if (!job || typeof job.id !== 'string') continue;
          if (job.status === 'running') {
            // The work died with the old process; a poller must get a clear
            // terminal state, not an eternal 'running'.
            job.status = 'error';
            job.error = 'interrupted: the server reloaded/restarted while this job was running — re-ask to run it again';
            job.finishedAt = job.finishedAt ?? Date.now();
            this.persist(job);
          }
          this.jobs.set(job.id, job);
        } catch { /* skip the one bad file */ }
      }
      this.prunePersisted();
    } catch { /* no jobs dir yet */ }
  }

  /** Atomic best-effort mirror of one job to disk (same tmp+rename discipline as saveState). */
  private persist(job: Job): void {
    try {
      const dir = jobsDir();
      mkdirSync(dir, { recursive: true });
      let payload = job;
      if (job.result !== undefined) {
        const size = Buffer.byteLength(JSON.stringify(job.result), 'utf8');
        if (size > MAX_PERSISTED_RESULT_BYTES) {
          // Keep the big result in memory for this process's lifetime, but
          // don't balloon the disk mirror — the persisted record says WHY the
          // result is absent instead of silently looking like a bug.
          payload = { ...job, result: undefined, error: job.error ?? `result too large to persist across reloads (${size} bytes) — fetch it before reloading` };
        }
      }
      const path = join(dir, `${job.id}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      renameSync(tmp, path);
      this.prunePersisted();
    } catch { /* persistence is a bonus, never a failure mode */ }
  }

  /** Keep only the newest MAX_PERSISTED job files. */
  private prunePersisted(): void {
    try {
      const dir = jobsDir();
      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      if (files.length <= MAX_PERSISTED) return;
      const dated = files.map(f => {
        try { return { f, at: (JSON.parse(readFileSync(join(dir, f), 'utf8')) as Job).startedAt ?? 0 }; }
        catch { return { f, at: 0 }; }
      }).sort((a, b) => a.at - b.at);
      while (dated.length > MAX_PERSISTED) {
        const victim = dated.shift()!;
        try { rmSync(join(dir, victim.f)); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }

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
    this.persist(job);
    this.evict();
    return job;
  }

  finish(id: string, result: unknown): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.result = result;
    job.finishedAt = Date.now();
    this.persist(job);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.error = error;
    job.finishedAt = Date.now();
    this.persist(job);
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
