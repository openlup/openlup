// Node (self-hosted) SchedulerPort adapter.
//
// Unlike a managed host with an adopter-owned declarative cron manifest, a self-hosted Node bundle owns the timers itself.
// This adapter:
//   1. Takes its job set from the platform-runtime configuration `crons` (the SAME single source
//      the managed-host adapter also reads), never a hand-copied list.
//   2. Registers each job with node-cron (injected lazily so `pg`/`node-cron` aren't required to
//      typecheck or to run the default vercel-supabase path).
//   3. Wraps every job body in a PER-JOB advisory lock: multi-instance Node must not
//      double-run a cron. Only the instance that acquires `pg_try_advisory_lock(<job>)` runs; others
//      skip. The lock is released in a finally, even if the body throws.

import type { SchedulerPort } from "@openlup/core/platform-runtime";
import type { HttpRequest } from "../http/index.js";
import type { ScheduledJobDeclaration } from "./jobRegistry.js";
import { verifyCronAuth } from "./vercelScheduler.js";
import { createNoopAdvisoryLock, type AdvisoryLock } from "./advisoryLock.js";

type CronEnv = Record<string, string | undefined> & { CRON_SECRET?: string };

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
  stopped: boolean;
}

export interface NodeSchedulerAdapter extends SchedulerPort {
  readonly jobs: readonly ScheduledJobDeclaration[];
  /** Fence/stop current timers synchronously, then await admitted callbacks and lock release. Later registration remains supported. */
  stopAll(): Promise<void>;
}

export interface CreateNodeSchedulerOptions {
  /** node-cron instance (inject `import("node-cron")` at the host boot site). */
  cron: CronScheduler;
  /**
   * Per-job lock capability; defaults to an always-granting no-op for
   * single-instance/test use, which does not serialize concurrent callbacks.
   * Supply a cluster-scoped lock when multiple instances must exclude one another.
   */
  lock?: AdvisoryLock;
  /** Environment whose CRON_SECRET verifies an invocation. */
  env: CronEnv;
  /** The deployment's declared jobs (see `loadJobRegistry`). */
  jobs: readonly ScheduledJobDeclaration[];
  /** Timezone node-cron uses to interpret the UTC-authored schedule; pass `UTC` for Vercel parity. */
  timezone?: string;
  /** Structured error sink for failed job bodies (defaults to console.error). */
  onError?: (jobId: string, error: unknown) => void;
}

/**
 * Wrap a job body with the supplied per-job lock capability. Returns a guarded runner that:
 *  - tries to acquire the lock; if acquisition is declined, skips without running the body;
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
      // Another instance holds the lock for this minute — skip (no double-run).
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

/** Build the Node scheduler adapter backed by node-cron and the supplied lock capability. */
export function createNodeScheduler(options: CreateNodeSchedulerOptions): NodeSchedulerAdapter {
  const env = options.env;
  const jobs = options.jobs;
  const lock = options.lock ?? createNoopAdvisoryLock();
  const onError =
    options.onError ??
    ((jobId: string, error: unknown) => {
      console.error(`[node-scheduler] job "${jobId}" failed`, error);
    });
  const scheduleById = new Map(jobs.map((job) => [job.jobId, job.schedule]));
  const timers: RegisteredTimer[] = [];
  const active = new Set<Promise<void>>();

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
      const registration: RegisteredTimer = { jobId: input.jobId, stop: () => {}, stopped: false };
      const timer = options.cron.schedule(schedule, () => {
        if (registration.stopped) return Promise.resolve();
        // Own the callback before acquisition starts, including a pending acquisition.
        const running = Promise.resolve().then(guarded);
        active.add(running);
        void running.then(() => active.delete(running), () => active.delete(running));
        return running;
      }, { timezone: options.timezone });
      registration.stop = timer.stop;
      timers.push(registration);
    },
    verifyInvocation(req: HttpRequest) {
      // Self-hosted invocations still present the shared CRON_SECRET; reuse the canonical check.
      return verifyCronAuth(req, env);
    },
    async stopAll() {
      const stopped = timers.splice(0);
      for (const timer of stopped) timer.stopped = true;
      const admitted = [...active];
      const failures: unknown[] = [];
      for (const timer of stopped) {
        try { timer.stop(); } catch (error) { failures.push(error); }
      }
      const results = await Promise.allSettled(admitted);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "node_scheduler_shutdown_failed");
    },
  };
}
