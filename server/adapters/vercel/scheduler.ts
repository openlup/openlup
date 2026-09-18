// Vercel cron SchedulerPort adapter (Platform Portability, W4).
//
// On Vercel, scheduling is declarative: an adopter-owned `crons` manifest generated from
// config/platform-runtime.json — the same single source this adapter reads — tells Vercel to GET
// each `/api/cron/*` endpoint on its schedule. So `register()` is a no-op verification step here —
// the platform owns the timer. What this adapter OWNS is invocation authenticity: every cron
// endpoint must verify `Authorization: Bearer ${CRON_SECRET}`, fail-closed when the secret is unset.
//
// `verifyCronAuth(req, env)` is the canonical, reusable form of the inline
// `req.headers.authorization !== \`Bearer ${CRON_SECRET}\`` checks scattered across api/cron/*.ts.
// New cron handlers (and the Node host) should call it instead of re-implementing the check.

import type { PlatformHttpRequest, SchedulerPort } from "../../../src/domains/platform-runtime/ports.js";
import { loadJobRegistry, type ScheduledJob } from "../scheduler/jobRegistry.js";

type CronEnv = Record<string, string | undefined> & { CRON_SECRET?: string };

/** Extract the Bearer token from a request Authorization header (case-insensitive). */
export function bearerToken(req: PlatformHttpRequest): string | null {
  const auth = req.headers.authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  return header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

/**
 * Verify a cron invocation is authentic. Fail-CLOSED:
 *  - CRON_SECRET unset                         -> false (never authorize when no secret configured)
 *  - presented Bearer token != CRON_SECRET     -> false
 *  - presented Bearer token == CRON_SECRET     -> true
 * This is the single canonical check that replaces the per-handler inline comparisons.
 */
export function verifyCronAuth(req: PlatformHttpRequest, env: CronEnv = process.env): boolean {
  const expected = env.CRON_SECRET;
  if (!expected) {
    return false;
  }
  return bearerToken(req) === expected;
}

export interface VercelSchedulerAdapter extends SchedulerPort {
  /** The jobs this scheduler knows about, derived from the platform-runtime single source. */
  readonly jobs: readonly ScheduledJob[];
}

/**
 * Build the Vercel cron scheduler adapter.
 *
 * `register()` validates the job is part of the declared registry (so callers can't silently
 * register a job Vercel will never fire) but does NOT start a timer — Vercel's cron does that.
 */
export function createVercelScheduler(options: {
  env?: CronEnv;
  jobs?: ScheduledJob[];
} = {}): VercelSchedulerAdapter {
  const env = options.env ?? process.env;
  const jobs = options.jobs ?? loadJobRegistry();
  const knownIds = new Set(jobs.map((job) => job.jobId));

  return {
    jobs,
    register(input) {
      // Vercel owns the timer through the adopter manifest. We only guard that the job is declared,
      // surfacing drift between code and the single-source registry at registration time.
      if (!knownIds.has(input.jobId)) {
        throw new Error(
          `vercel-scheduler: job "${input.jobId}" is not declared in config/platform-runtime.json crons`,
        );
      }
      // No-op timer: the handler at the cron path is invoked by Vercel directly.
    },
    verifyInvocation(req) {
      return verifyCronAuth(req, env);
    },
  };
}
