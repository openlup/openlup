import type { JobCatalogEntry } from "./observabilityContracts.js";

// Sales-channel scheduled jobs, split out rather than appended to `jobCatalog.ts`: that file sits
// exactly on its legacy size cap, and the cap is shrink-only, so a domain that will grow gets its
// own module the way promotions and accounting already have theirs.
//
// `requiresFlag` IS the alert-silence mechanism for a default-off job, and it was chosen after
// reading how the evaluator actually gates rather than assumed. `observabilityEvaluator.ts` walks
// three gates in this order:
//
//   1. `isJobMonitorActive` — the `requiresFlag` / `monitoringState` gate;
//   2. `if (!control)` — a job with NO `platform_job_controls` row pages `job_ledger_missing`;
//   3. `if (!control.enabled) continue` — a DISABLED control row is skipped.
//
// So the watchdog does read control state, and gate 3 alone would keep a seeded-disabled job quiet.
// But gate 2 fires BEFORE it, which means the deploy-before-migrate window — this catalogue entry
// live while the control-row forward has not been applied yet, and any developer database in that
// state — would page for a job nobody has ever turned on. `requiresFlag` closes that, because it is
// evaluated first and the flag is default-off in every environment.
//
// Every field below is kept identical to the `scheduledJobs[].alert` projection in
// adopter-owned scheduler configuration, runbook included: a JOB_CATALOG entry pointing somewhere else would
// be a second, divergent answer to the same question.

export const CHANNELS_JOB_CATALOG: readonly JobCatalogEntry[] = [
  {
    jobName: "channel-order-pull",
    owner: "commerce/channels",
    severity: "p3",
    expectedEverySeconds: 15 * 60,
    startGraceSeconds: 30 * 60,
    finishGraceSeconds: 15 * 60,
    runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    alertChannels: ["webhook"],
    requiresFlag: "CHANNEL_ORDER_PULL_ENABLED",
  },
];
