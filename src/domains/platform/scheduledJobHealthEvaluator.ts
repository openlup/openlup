import { humanContextForJobAlert } from "./alertHumanContext.js";
import type {
  AlertDecision,
  JobCatalogEntry,
  JobControlSnapshot,
  JobRunSnapshot,
} from "./observabilityContracts.js";

const MILLIS_PER_SECOND = 1000;

export function collectScheduledJobAlerts(
  decisions: AlertDecision[],
  job: JobCatalogEntry,
  control: JobControlSnapshot,
  recentJobRuns: JobRunSnapshot[],
  now: Date,
): void {
  collectScheduleHealth(decisions, job, control, recentJobRuns, now);
  collectStaleRunningJob(decisions, job, control, now);
}

export function jobAlert(
  job: JobCatalogEntry,
  reason: string,
  title: string,
  payload: Record<string, unknown>,
): AlertDecision {
  return {
    dedupeKey: `${reason}:${job.jobName}`,
    severity: job.severity,
    owner: job.owner,
    runbookUrl: job.runbookUrl,
    title,
    message: String(payload.message ?? title),
    humanContext: humanContextForJobAlert(job, reason),
    channels: job.alertChannels,
    payload: { jobName: job.jobName, reason, ...payload },
  };
}

function collectScheduleHealth(
  decisions: AlertDecision[],
  job: JobCatalogEntry,
  control: JobControlSnapshot,
  recentJobRuns: JobRunSnapshot[],
  now: Date,
): void {
  if (!job.expectedEverySeconds) return;
  const latestTerminalRun = latestTerminalJobRun(recentJobRuns, job.jobName);
  const latestFailedRun = (
    latestTerminalRun?.status === "failed" && (
      !control.lastSuccessAt || Date.parse(latestTerminalRun.startedAt) > Date.parse(control.lastSuccessAt)
    )
  ) ? latestTerminalRun : undefined;
  if (control.lastStatus === "failed" || latestFailedRun) {
    decisions.push(jobAlert(job, "job_failed", `Scheduled job failed: ${job.jobName}`, {
      message: `${job.jobName} latest attempt failed.`,
      lastStartedAt: latestFailedRun?.startedAt ?? control.lastStartedAt,
      lastFinishedAt: latestFailedRun?.finishedAt ?? control.lastFinishedAt,
      supportCode: latestFailedRun?.supportCode ?? null,
    }));
    return;
  }

  if (control.lastStatus === "running") return;

  const allowedSeconds = job.expectedEverySeconds + job.startGraceSeconds;
  const latestAttemptAt = control.lastStartedAt ?? control.lastFinishedAt;
  if (!control.lastSuccessAt) {
    if (latestAttemptAt && secondsSince(latestAttemptAt, now) <= allowedSeconds) return;
    decisions.push(jobAlert(job, "job_never_succeeded", `Job never succeeded: ${job.jobName}`, {
      message: `${job.jobName} is enabled but has no recorded success.`,
      lastStatus: control.lastStatus,
    }));
    return;
  }

  const ageSeconds = secondsSince(control.lastSuccessAt, now);
  if (ageSeconds <= allowedSeconds) return;
  if (latestAttemptAt && secondsSince(latestAttemptAt, now) <= allowedSeconds) return;

  decisions.push(jobAlert(job, "job_missed", `Scheduled job missed: ${job.jobName}`, {
    message: `${job.jobName} last succeeded ${Math.floor(ageSeconds / 60)} minutes ago.`,
    lastSuccessAt: control.lastSuccessAt,
    allowedSeconds,
    ageSeconds,
  }));
}

function collectStaleRunningJob(
  decisions: AlertDecision[],
  job: JobCatalogEntry,
  control: JobControlSnapshot,
  now: Date,
): void {
  if (control.lastStatus !== "running" || !control.lastStartedAt) return;
  const runningSeconds = secondsSince(control.lastStartedAt, now);
  const leaseExpired = control.leaseUntil ? new Date(control.leaseUntil).getTime() < now.getTime() : false;
  if (runningSeconds <= job.finishGraceSeconds && !leaseExpired) return;

  decisions.push(jobAlert(job, "job_stuck_running", `Scheduled job stuck running: ${job.jobName}`, {
    message: `${job.jobName} has been running for ${Math.floor(runningSeconds / 60)} minutes.`,
    lastStartedAt: control.lastStartedAt,
    leaseUntil: control.leaseUntil,
    runningSeconds,
    leaseExpired,
  }));
}

function latestTerminalJobRun(recentJobRuns: JobRunSnapshot[], jobName: string): JobRunSnapshot | undefined {
  return recentJobRuns
    .filter((run) => run.jobName === jobName && (run.status === "success" || run.status === "failed"))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
}

function secondsSince(timestamp: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(timestamp).getTime()) / MILLIS_PER_SECOND));
}
