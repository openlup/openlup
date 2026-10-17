// Authenticated HTTP cron entry for a transport-neutral scheduled job.
//
// The entry is an adapter: it applies the cron guard (method, configured secret, bearer token) and
// only then runs the job with an HTTP invocation. A refusal answers the guard's own status and
// body. A run answers 200 with its result, a lease held elsewhere answers 200 as skipped, and a
// failed run answers 500 without error detail; the error goes to the host's error sink.

import type { JobLeasePort } from "@openlup/core/platform-runtime";

import type { HttpRequest, HttpResponse } from "../http/index.js";
import { authorizeCron } from "./cronGuard.js";
import { runScheduledJob, type ScheduledJob } from "./jobs.js";

export interface ScheduledJobHttpEntryOptions {
  /** Environment whose CRON_SECRET authenticates the caller, read on each request. */
  env: () => { CRON_SECRET?: string };
  /** Evidence recorded for HTTP invocations, for example the hosting platform's cron. */
  invocationSource: string;
  /** The job-lease port, required when the job declares a lease. */
  lease?: JobLeasePort;
  /** Error sink for a failed run (defaults to console.error). */
  onError?: (jobId: string, error: unknown) => void;
}

export function createScheduledJobHttpEntry(
  job: ScheduledJob,
  options: ScheduledJobHttpEntryOptions,
): (req: HttpRequest, res: HttpResponse) => Promise<void> {
  const onError = options.onError ?? ((jobId, error) => console.error(`[scheduled-job] "${jobId}" failed`, error));
  return async function scheduledJobEntry(req, res) {
    const denied = authorizeCron(req, options.env());
    if (denied) {
      res.status(denied.status).json(denied.body);
      return;
    }
    try {
      const result = await runScheduledJob(job, {
        invocation: { triggerKind: "scheduler", invocationSource: options.invocationSource },
        lease: options.lease,
      });
      res.status(200).json(result.status === "skipped"
        ? { ok: true, skipped: true, reason: result.reason }
        : { ok: true, result: result.summary });
    } catch (error) {
      onError(job.id, error);
      res.status(500).json({ ok: false, error: "scheduled_job_failed" });
    }
  };
}
