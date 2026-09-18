import type { NoLedgerJobException } from "./observabilityContracts.js";

export const NO_LEDGER_JOB_EXCEPTIONS: readonly NoLedgerJobException[] = [
  {
    id: "vercel-cleanup",
    path: "/api/cron/cleanup",
    reason: "Best-effort Vercel Blob cleanup records cleanup_run events instead of platform_job_runs.",
    evidence: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
  },
  {
    id: "email-health-watchdog",
    path: "/api/cron/email-health-watchdog",
    reason: "Read-only email-deliverability watchdog: it reads the communication_email_deliveries timeline and returns 503 on a breach (no platform_job_runs ledger of its own — it IS the alerting signal).",
    evidence: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
  },
  {
    id: "staging-rollout-tick",
    path: "/api/cron/staging-rollout-tick",
    reason: "GitHub-scheduler-independent trigger: workflow_dispatches Staging Batch Controller (force=false; controller decides due/skip). No platform_job_runs ledger of its own — the immutable Auto Deploy Staging run and its staging/* commit statuses are the durable record.",
    evidence: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
  },
];
