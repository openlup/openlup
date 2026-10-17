// Transport-neutral scheduled jobs.
//
// A job is `{ id, schedule, lease?, run(context) }`. Domains and packages contribute jobs to a
// registry; a host runs them on its own timer or through an authenticated HTTP cron entry, and both
// call the same `run`. The in-process path carries no HTTP secret. When a job declares a lease, the
// runner claims it through the deployment's job-lease port first and skips the run when another
// instance holds it; a job that fences its own work (for example the outbox) declares no lease.

import type {
  JobLeasePort,
  PlatformJobFinishSummary,
  PlatformJobInvocation,
} from "@openlup/core/platform-runtime";

export interface ScheduledJobContext {
  /** Who triggered this run; evidence only, never an authorization control. */
  readonly invocation: PlatformJobInvocation;
  /** The lease's run id when the job declares a lease. */
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export interface ScheduledJob {
  readonly id: string;
  /** Crontab expression (UTC). */
  readonly schedule: string;
  /** Claim a job-run lease of this many seconds before running. */
  readonly lease?: { readonly seconds: number };
  run(context: ScheduledJobContext): Promise<PlatformJobFinishSummary | void> | PlatformJobFinishSummary | void;
}

export type ScheduledJobRunResult =
  | { readonly status: "completed"; readonly summary: PlatformJobFinishSummary | null }
  | { readonly status: "skipped"; readonly reason: string };

const EMPTY_SUMMARY: PlatformJobFinishSummary = { checked: 0, updated: 0, failures: 0, skipped: false };

/** Merge contributed jobs into one registry; refuses a duplicate id or an empty id or schedule. */
export function createScheduledJobRegistry(
  ...contributions: ReadonlyArray<readonly ScheduledJob[]>
): readonly ScheduledJob[] {
  const seen = new Set<string>();
  const jobs: ScheduledJob[] = [];
  for (const job of contributions.flat()) {
    if (!job.id?.trim()) throw new Error("scheduled_job_id_required");
    if (!job.schedule?.trim()) throw new Error(`scheduled_job_schedule_required:${job.id}`);
    if (seen.has(job.id)) throw new Error(`scheduled_job_duplicate:${job.id}`);
    seen.add(job.id);
    jobs.push(job);
  }
  return Object.freeze(jobs);
}

/**
 * The cron expression for a fixed cadence: a whole number of minutes that divides an hour, or a
 * whole number of hours that divides a day. Any other cadence is refused rather than approximated.
 */
export function cronFromCadenceSeconds(cadenceSeconds: number): string {
  if (Number.isInteger(cadenceSeconds) && cadenceSeconds > 0 && cadenceSeconds % 60 === 0) {
    const minutes = cadenceSeconds / 60;
    if (minutes < 60 && 60 % minutes === 0) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`;
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      if (hours === 24) return "0 0 * * *";
      if (hours < 24 && 24 % hours === 0) return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
    }
  }
  throw new Error(`scheduled_job_cadence_unsupported:${cadenceSeconds}`);
}

/**
 * Jobs for a package contribution's cadence schedules; each run passes the invocation through. A
 * run that reports `{ outcome: "failed" }` instead of throwing fails the job, so neither transport
 * reports it as completed.
 */
export function scheduledJobsFromContribution(
  schedules: ReadonlyArray<{ id: string; cadenceSeconds: number; run: (invocation: PlatformJobInvocation) => unknown }>,
): ScheduledJob[] {
  return schedules.map((schedule) => ({
    id: schedule.id,
    schedule: cronFromCadenceSeconds(schedule.cadenceSeconds),
    async run({ invocation }) {
      const result = await schedule.run(invocation);
      if (typeof result === "object" && result !== null && (result as { outcome?: unknown }).outcome === "failed") {
        throw new Error(`scheduled_job_outcome_failed:${schedule.id}`);
      }
    },
  }));
}

/** Run one job once, under its lease when it declares one. */
export async function runScheduledJob(
  job: ScheduledJob,
  options: { invocation: PlatformJobInvocation; lease?: JobLeasePort; signal?: AbortSignal },
): Promise<ScheduledJobRunResult> {
  if (!job.lease) {
    const summary = await job.run({ invocation: options.invocation, signal: options.signal });
    return { status: "completed", summary: summary ?? null };
  }
  if (!options.lease) throw new Error(`scheduled_job_lease_port_required:${job.id}`);
  const claim = await options.lease.claimJobRun(job.id, options.invocation, job.lease.seconds);
  if (!claim.acquired) return { status: "skipped", reason: claim.reason };
  if (!claim.runId) throw new Error(`scheduled_job_lease_without_run_id:${job.id}`);
  let summary: PlatformJobFinishSummary | void;
  try {
    summary = await job.run({ invocation: options.invocation, runId: claim.runId, signal: options.signal });
  } catch (error) {
    try {
      await options.lease.finishJobRun(job.id, claim.runId, options.invocation, "failed", { ...EMPTY_SUMMARY, failures: 1 });
    } catch (finishError) {
      throw new AggregateError([error, finishError], `scheduled_job_failed_unfinished:${job.id}`);
    }
    throw error;
  }
  const finished = await options.lease.finishJobRun(job.id, claim.runId, options.invocation, "success", summary ?? EMPTY_SUMMARY);
  // A refused finish means the lease no longer belongs to this run; its result cannot be recorded.
  if (!finished) throw new Error(`scheduled_job_finish_refused:${job.id}`);
  return { status: "completed", summary: summary ?? null };
}
