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
  /**
   * Process that owns the run. Several session servers share one jobs dir
   * (they share the state file), so "running" on disk is ambiguous without it:
   * a booting server must only declare a job interrupted when its OWNER is
   * actually dead — observed live, one session's reload marked 20 jobs
   * interrupted that another session's still-alive server was running.
   */
  pid?: number;
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

/** Is the process that owns a job still alive? signal 0 probes without sending; EPERM means alive-but-not-ours. */
function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as { code?: string }).code === 'EPERM'; }
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
          if (job.status === 'running' && !pidAlive(job.pid)) {
            // The owner is dead, so the work died with it; a poller must get
            // a clear terminal state, not an eternal 'running'. A running job
            // whose owner is ALIVE belongs to another session's server and is
            // left exactly as it is — declaring it interrupted from here was
            // observed to falsify 20 in-flight jobs in one reload. (A legacy
            // record with no pid is treated as dead: before pids were
            // recorded, only a dead process could have left one behind.)
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

  /**
   * Keep the jobs dir bounded — but not status-blind. Observed live: one
   * session's 20-job burst of freshly-STARTED records evicted another
   * session's done-but-unfetched result, which is precisely the record this
   * persistence exists to protect. Eviction order is therefore: errors first,
   * then done, each oldest-first — and a RUNNING job whose owner is alive is
   * never deleted at all (its record is the only route to its result).
   */
  private prunePersisted(): void {
    try {
      const dir = jobsDir();
      const files = readdirSync(dir).filter(f => f.endsWith('.json'));
      if (files.length <= MAX_PERSISTED) return;
      const rank = (j: Job | null): number =>
        !j ? 0                                            // unparseable: first out
        : j.status === 'error' ? 1
        : j.status === 'done' ? 2
        : pidAlive(j.pid) ? 3                             // live running: never evicted
        : 1;                                              // dead running ≈ an error
      const dated = files.map(f => {
        let j: Job | null = null;
        try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Job; } catch { /* rank 0 */ }
        return { f, at: j?.startedAt ?? 0, rank: rank(j) };
      }).sort((a, b) => a.rank - b.rank || a.at - b.at);
      let excess = dated.length - MAX_PERSISTED;
      for (const victim of dated) {
        if (excess <= 0) break;
        if (victim.rank >= 3) break; // only live-running jobs remain — keep all
        try { rmSync(join(dir, victim.f)); excess--; } catch { /* best-effort */ }
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
      pid: process.pid,
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
    const job = this.jobs.get(id);
    // A running job owned by ANOTHER live process only ever changes on disk —
    // its finish happens in that process's memory, not ours — so serve the
    // freshest disk state rather than an in-memory snapshot frozen at our
    // boot. This is what makes a job visible and pollable across sessions.
    if (job && job.status === 'running' && job.pid !== undefined && job.pid !== process.pid) {
      try {
        const fresh = JSON.parse(readFileSync(join(jobsDir(), `${id}.json`), 'utf8')) as Job;
        if (fresh && fresh.id === id) {
          this.jobs.set(id, fresh);
          return fresh;
        }
      } catch { /* file pruned/unreadable — the snapshot is all we have */ }
    }
    return job;
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
