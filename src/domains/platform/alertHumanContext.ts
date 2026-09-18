import type { AlertSeverity, JobCatalogEntry } from "./observabilityContracts.js";

export type AlertIncidentClass =
  | "customer_communication_failure"
  | "scheduled_job_failed"
  | "scheduled_job_missed"
  | "fulfillment_tracking_stalled"
  | "configuration_drift"
  | "data_integrity"
  | "queue_backlog"
  | "recipient_configuration_failure"
  | "platform_watchdog";

export type AlertHumanContext = {
  incidentClass: AlertIncidentClass;
  impact: string;
  firstAction: string;
  urgency: string;
};

export function humanContextForJobAlert(job: JobCatalogEntry, reason: string): AlertHumanContext {
  const isDhlTracking = job.jobName === "check-dhl-tracking";
  const incidentClass = isDhlTracking
    ? "fulfillment_tracking_stalled"
    : reason === "job_failed" ? "scheduled_job_failed" : "scheduled_job_missed";
  const impact = isDhlTracking
    ? "DHL tracking refresh is stale; operators may see outdated shipment states and customers may miss shipment status updates."
    : reason === "job_failed"
      ? `${job.jobName} ran and failed, so the workflow it owns may be stalled until a retry succeeds.`
    : `${job.jobName} is not producing fresh successful run evidence, so the workflow it owns may be stalled.`;
  const firstAction = isDhlTracking
    ? "Check platform_job_runs for check-dhl-tracking, then inspect runtime logs for /api/cron/dhl-tracking and DHL credential/provider errors."
    : firstActionForScheduledJob(job.jobName, reason);

  return { incidentClass, impact, firstAction, urgency: urgencyForSeverity(job.severity) };
}

export function urgencyForSeverity(severity: AlertSeverity): string {
  switch (severity) {
    case "p0":
      return "P0: immediate incident response; customer-impacting production outage is likely.";
    case "p1":
      return "P1: page now; customer impact or critical operational blind spot is likely.";
    case "p2":
      return "P2: investigate during the current ops window; degraded automation or stale evidence is likely.";
    case "p3":
      return "P3: track and fix; no immediate customer-impacting outage is proven.";
  }
}

function firstActionForScheduledJob(jobName: string, reason: string): string {
  if (reason === "job_stuck_running") {
    return `Check the ${jobName} platform_job_controls lease and latest platform_job_runs row before replaying the job.`;
  }
  if (reason === "job_ledger_missing") {
    return `Confirm ${jobName} is seeded into platform_job_controls and that the evidence port can read the production database.`;
  }
  return `Check platform_job_controls and the latest platform_job_runs rows for ${jobName}, then inspect the owning cron or worker logs.`;
}
