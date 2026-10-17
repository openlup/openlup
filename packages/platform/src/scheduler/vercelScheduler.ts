// Vercel cron SchedulerPort adapter.
//
// On Vercel, scheduling is declarative: an adopter-owned `crons` manifest generated from the
// platform-runtime configuration (the same single source as `jobs`) tells Vercel to GET
// each `/api/cron/*` endpoint on its schedule. So `register()` is a no-op verification step here —
// the platform owns the timer. What this adapter OWNS is invocation authenticity: every cron
// endpoint must verify `Authorization: Bearer ${CRON_SECRET}`, fail-closed when the secret is unset.
//
// `verifyCronAuth(req, env)` is the reusable form of a bearer check against CRON_SECRET; cron
// handlers and the Node host call it instead of re-implementing the comparison.

import type { PlatformHttpRequest, SchedulerPort } from "@openlup/core/platform-runtime";
import type { ScheduledJobDeclaration } from "./jobRegistry.js";
import { bearerToken, cronSecretMatches } from "./cronSecret.js";

type CronEnv = Record<string, string | undefined> & { CRON_SECRET?: string };

export { bearerToken } from "./cronSecret.js";

/**
 * Verify a cron invocation is authentic. Fail-CLOSED:
 *  - CRON_SECRET unset                         -> false (never authorize when no secret configured)
 *  - presented Bearer token != CRON_SECRET     -> false
 *  - presented Bearer token == CRON_SECRET     -> true
 * This is the single canonical check that replaces the per-handler inline comparisons.
 */
export function verifyCronAuth(req: PlatformHttpRequest, env: CronEnv): boolean {
  const expected = env.CRON_SECRET;
  if (!expected) {
    return false;
  }
  return cronSecretMatches(bearerToken(req), expected);
}

export interface VercelSchedulerAdapter extends SchedulerPort {
  /** The jobs this scheduler knows about, derived from the platform-runtime single source. */
  readonly jobs: readonly ScheduledJobDeclaration[];
}

/**
 * Build the Vercel cron scheduler adapter.
 *
 * `register()` validates the job is part of the declared registry (so callers can't silently
 * register a job Vercel will never fire) but does NOT start a timer — Vercel's cron does that.
 */
export function createVercelScheduler(options: {
  env: CronEnv;
  /** The deployment's declared jobs (see `loadJobRegistry`). */
  jobs: readonly ScheduledJobDeclaration[];
}): VercelSchedulerAdapter {
  const env = options.env;
  const jobs = options.jobs;
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
