/**
 * Persistent, in-process job queue (ARCHITECTURE.md §3): jobs live in SQLite, so
 * a restart resumes them. One worker runs one job at a time; long work never
 * runs inside a request handler.
 */
import type { Db } from "../db/db.ts";
import type { Logger } from "../log.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: number;
  kind: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  dedupeKey: string | null;
  progress: unknown;
  result: unknown;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobContext {
  job: Job;
  /** Aborted when cancellation is requested or the queue stops. */
  signal: AbortSignal;
  /** Persist handler-defined progress; cheap enough to call per item. */
  progress(value: unknown): void;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** Thrown by a handler for errors that retrying cannot fix. */
export class PermanentJobError extends Error {
  override name = "PermanentJobError";
}

export interface EnqueueOptions {
  dedupeKey?: string;
  runAfter?: number;
  maxAttempts?: number;
}

interface JobRow {
  id: number;
  kind: string;
  payload: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_after: number;
  dedupe_key: string | null;
  cancel_requested: number;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function parse(s: string | null): unknown {
  return s === null ? null : JSON.parse(s);
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: parse(r.payload),
    state: r.state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    dedupeKey: r.dedupe_key,
    progress: parse(r.progress),
    result: parse(r.result),
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export interface JobQueueOptions {
  logger: Logger;
  /** Fallback poll interval for delayed jobs (ms). */
  pollMs?: number;
  /** Base retry delay (ms); doubles per attempt. */
  retryBaseMs?: number;
  now?: () => number;
}

export class JobQueue {
  #db: Db;
  #opts: Required<JobQueueOptions>;
  #handlers = new Map<string, JobHandler>();
  #running = false;
  #loop?: Promise<void>;
  #wake?: () => void;
  #current?: { id: number; abort: AbortController };
  #lastProgressWrite = 0;

  constructor(db: Db, opts: JobQueueOptions) {
    this.#db = db;
    this.#opts = { pollMs: 1000, retryBaseMs: 5000, now: Date.now, ...opts };
  }

  register(kind: string, handler: JobHandler): void {
    this.#handlers.set(kind, handler);
  }

  /** Enqueues a job, or returns the live job with the same dedupe key. */
  enqueue(kind: string, payload: unknown = {}, opts: EnqueueOptions = {}): Job {
    const now = this.#opts.now();
    if (opts.dedupeKey) {
      const live = this.#db.prepare(
        "SELECT * FROM job WHERE dedupe_key = ? AND state IN ('queued', 'running')",
      ).get(opts.dedupeKey) as JobRow | undefined;
      if (live) return toJob(live);
    }
    const row = this.#db.prepare(
      `INSERT INTO job (kind, payload, run_after, dedupe_key, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      kind,
      JSON.stringify(payload),
      opts.runAfter ?? now,
      opts.dedupeKey ?? null,
      opts.maxAttempts ?? 3,
      now,
    ) as unknown as JobRow;
    this.#wake?.();
    return toJob(row);
  }

  get(id: number): Job | undefined {
    const r = this.#db.prepare("SELECT * FROM job WHERE id = ?").get(id) as JobRow | undefined;
    return r && toJob(r);
  }

  /** Most recent job of a kind, optionally restricted to states. */
  latest(kind: string, states?: JobState[]): Job | undefined {
    const where = states?.length ? `AND state IN (${states.map(() => "?").join(",")})` : "";
    const r = this.#db.prepare(`SELECT * FROM job WHERE kind = ? ${where} ORDER BY id DESC LIMIT 1`).get(
      kind,
      ...(states ?? []),
    ) as JobRow | undefined;
    return r && toJob(r);
  }

  /** Queued jobs are cancelled at once; a running job is asked to stop via its signal. */
  cancel(id: number): Job | undefined {
    const now = this.#opts.now();
    this.#db.prepare(
      "UPDATE job SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'",
    ).run(now, id);
    this.#db.prepare("UPDATE job SET cancel_requested = 1 WHERE id = ? AND state = 'running'").run(id);
    if (this.#current?.id === id) this.#current.abort.abort(new DOMException("cancelled", "AbortError"));
    return this.get(id);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    // A job left 'running' was interrupted by a restart: run it again without counting an attempt.
    this.#db.prepare("UPDATE job SET state = 'queued', started_at = NULL WHERE state = 'running'").run();
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#current?.abort.abort(new DOMException("queue stopping", "AbortError"));
    this.#wake?.();
    await this.#loop;
  }

  /** Runs ready jobs until none remain; for tests. */
  async drain(): Promise<void> {
    while (await this.#runOne()) { /* keep going */ }
  }

  async #run(): Promise<void> {
    while (this.#running) {
      let ran = false;
      try {
        ran = await this.#runOne();
      } catch (e) {
        this.#opts.logger.error("job queue loop error", { error: String(e) });
      }
      if (ran || !this.#running) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.#opts.pollMs);
        this.#wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }

  #claim(): JobRow | undefined {
    const now = this.#opts.now();
    return this.#db.prepare(
      `UPDATE job SET state = 'running', attempts = attempts + 1, started_at = ?, error = NULL
       WHERE id = (SELECT id FROM job WHERE state = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
    ).get(now, now) as JobRow | undefined;
  }

  async #runOne(): Promise<boolean> {
    const row = this.#claim();
    if (!row) return false;
    const job = toJob(row);
    const handler = this.#handlers.get(job.kind);
    if (!handler) {
      this.#finish(job.id, "failed", null, `no handler for job kind "${job.kind}"`);
      return true;
    }
    const abort = new AbortController();
    this.#current = { id: job.id, abort };
    const log = this.#opts.logger;
    log.info("job started", { id: job.id, kind: job.kind, attempt: job.attempts });
    try {
      const result = await handler({ job, signal: abort.signal, progress: (p) => this.#progress(job.id, p) });
      this.#finish(job.id, "done", result ?? null, null);
      log.info("job done", { id: job.id, kind: job.kind });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cancelled = (this.#db.prepare("SELECT cancel_requested c FROM job WHERE id = ?").get(job.id) as {
        c: number;
      }).c === 1;
      if (cancelled) {
        this.#finish(job.id, "cancelled", null, null);
        log.info("job cancelled", { id: job.id, kind: job.kind });
      } else if (abort.signal.aborted && !this.#running) {
        // Stopped by shutdown: leave it for the next start.
        this.#db.prepare("UPDATE job SET state = 'queued', attempts = attempts - 1, started_at = NULL WHERE id = ?")
          .run(job.id);
      } else if (!(e instanceof PermanentJobError) && job.attempts < job.maxAttempts) {
        const delay = this.#opts.retryBaseMs * 2 ** (job.attempts - 1) * (1 + Math.random() * 0.2);
        this.#db.prepare("UPDATE job SET state = 'queued', run_after = ?, error = ? WHERE id = ?").run(
          this.#opts.now() + Math.round(delay),
          msg,
          job.id,
        );
        log.warn("job failed, will retry", { id: job.id, kind: job.kind, attempt: job.attempts, error: msg });
      } else {
        this.#finish(job.id, "failed", null, msg);
        log.error("job failed", { id: job.id, kind: job.kind, error: msg });
      }
    } finally {
      this.#current = undefined;
    }
    return true;
  }

  #progress(id: number, value: unknown): void {
    // Throttle writes; the UI polls about once a second.
    const now = this.#opts.now();
    if (now - this.#lastProgressWrite < 250) return;
    this.#lastProgressWrite = now;
    this.#db.prepare("UPDATE job SET progress = ? WHERE id = ?").run(JSON.stringify(value), id);
  }

  #finish(id: number, state: JobState, result: unknown, error: string | null): void {
    this.#db.prepare("UPDATE job SET state = ?, result = ?, error = ?, finished_at = ? WHERE id = ?").run(
      state,
      result === null ? null : JSON.stringify(result),
      error,
      this.#opts.now(),
      id,
    );
  }
}
