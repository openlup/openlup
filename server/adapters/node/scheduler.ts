// Node (self-hosted) SchedulerPort adapter (Platform Portability, W4).
//
// Unlike a managed host with an adopter-owned declarative cron manifest, a self-hosted Node bundle owns the timers itself.
// This adapter:
//   1. Derives its job set from config/platform-runtime.json `crons` (the SAME single source the
//      managed-host adapter also reads) — never a hand-copied list.
//   2. Registers each job with node-cron (injected lazily so `pg`/`node-cron` aren't required to
//      typecheck or to run the default vercel-supabase path).
//   3. Wraps every job body in a PER-JOB advisory lock (invariant #2): multi-instance Node must not
//      double-run a cron. Only the instance that acquires `pg_try_advisory_lock(<job>)` runs; others
//      skip. The lock is released in a finally, even if the body throws.
//
// IN-DB pg_cron HISTORY: repository migrations retain declarations that once called Supabase Edge
// roots through `net.http_post`. The tester email queue, packaging digest, and daily report jobs are
// now unscheduled and their local roots return 404; their declarations are audit history, not Node
// SchedulerPort work. Active self-hosted jobs come only from config/platform-runtime.json.

import type { HttpRequest } from "../../_lib/types/http.js";
import type { SchedulerPort } from "../../../src/domains/platform-runtime/ports.js";
import { loadJobRegistry, type ScheduledJob } from "../scheduler/jobRegistry.js";
import { verifyCronAuth } from "../vercel/scheduler.js";
import { createNoopAdvisoryLock, type AdvisoryLock } from "./advisoryLock.js";

type CronEnv = Record<string, string | undefined> & { CRON_SECRET?: string };

/** The public reference registers no staging bridge profile; adopters declare scheduler jobs in config/platform-runtime.json. */
/** Minimal node-cron surface we depend on (keeps the package optional at type level). */
export interface CronScheduler {
  schedule(
    expression: string,
    handler: () => void | Promise<void>,
    options?: { timezone?: string },
  ): { stop: () => void };
}

interface RegisteredTimer {
  jobId: string;
  stop: () => void;
}

export interface NodeSchedulerAdapter extends SchedulerPort {
  readonly jobs: readonly ScheduledJob[];
  /** Stop all registered node-cron timers (graceful shutdown). */
  stopAll(): void;
}

export interface CreateNodeSchedulerOptions {
  /** node-cron instance (inject `import("node-cron")` at the host boot site). */
  cron: CronScheduler;
  /** Per-job advisory lock; defaults to a no-op (single-instance) — supply pg-backed in prod. */
  lock?: AdvisoryLock;
  env?: CronEnv;
  jobs?: ScheduledJob[];
  /** crontab timezone; jobs are authored in UTC to match Vercel. */
  timezone?: string;
  /** Structured error sink for failed job bodies (defaults to console.error). */
  onError?: (jobId: string, error: unknown) => void;
}

/**
 * Wrap a job body with the per-job advisory lock. Returns a guarded runner that:
 *  - tries to acquire the lock; if not acquired (another instance is running it) -> skip silently;
 *  - runs the body; always releases the lock in finally.
 */
export function withAdvisoryLock(
  jobId: string,
  lock: AdvisoryLock,
  body: () => Promise<void> | void,
  onError: (jobId: string, error: unknown) => void,
): () => Promise<void> {
  return async () => {
    const acquired = await lock.tryAcquire(jobId);
    if (!acquired) {
      // Another instance holds the lock for this minute — skip (invariant #2: no double-run).
      return;
    }
    try {
      await body();
    } catch (error) {
      onError(jobId, error);
    } finally {
      await lock.release(jobId);
    }
  };
}

/** Build the Node scheduler adapter backed by node-cron + per-job advisory locks. */
export function createNodeScheduler(options: CreateNodeSchedulerOptions): NodeSchedulerAdapter {
  const env = options.env ?? process.env;
  const jobs = options.jobs ?? loadJobRegistry();
  const lock = options.lock ?? createNoopAdvisoryLock();
  const onError =
    options.onError ??
    ((jobId: string, error: unknown) => {
      console.error(`[node-scheduler] job "${jobId}" failed`, error);
    });
  const scheduleById = new Map(jobs.map((job) => [job.jobId, job.schedule]));
  const timers: RegisteredTimer[] = [];

  return {
    jobs,
    register(input) {
      // Prefer an explicit schedule; fall back to the single-source registry when the caller
      // omits one (empty string or undefined both fall back).
      const explicit = input.schedule?.trim();
      const schedule = explicit && explicit.length > 0 ? explicit : scheduleById.get(input.jobId);
      if (!schedule) {
        throw new Error(
          `node-scheduler: job "${input.jobId}" is not declared in config/platform-runtime.json crons`,
        );
      }
      const guarded = withAdvisoryLock(input.jobId, lock, input.handler, onError);
      const timer = options.cron.schedule(schedule, guarded, { timezone: options.timezone });
      timers.push({ jobId: input.jobId, stop: timer.stop });
    },
    verifyInvocation(req: HttpRequest) {
      // Self-hosted invocations still present the shared CRON_SECRET; reuse the canonical check.
      return verifyCronAuth(req, env);
    },
    stopAll() {
      for (const timer of timers) {
        timer.stop();
      }
      timers.length = 0;
    },
  };
}
