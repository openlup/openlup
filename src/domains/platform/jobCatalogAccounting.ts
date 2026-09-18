import type { JobCatalogEntry } from "./observabilityContracts.js";

const OBS_RUNBOOK = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";

export const ACCOUNTING_JOB_CATALOG: readonly JobCatalogEntry[] = [
  {
    jobName: "accounting-invoice-issue",
    owner: "commerce/accounting",
    severity: "p1",
    expectedEverySeconds: 60 * 60,
    startGraceSeconds: 30 * 60,
    finishGraceSeconds: 15 * 60,
    queueBacklogGraceSeconds: 60 * 60,
    runbookUrl: OBS_RUNBOOK,
    alertChannels: ["webhook"],
    requiresFlag: "COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED",
  },
  {
    jobName: "accounting-ksef-status",
    owner: "commerce/accounting",
    severity: "p1",
    startGraceSeconds: 30 * 60,
    finishGraceSeconds: 15 * 60,
    runbookUrl: OBS_RUNBOOK,
    alertChannels: ["webhook"],
    requiresFlag: "COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED",
  },
  {
    jobName: "accounting-invoice-delivery",
    owner: "commerce/accounting",
    severity: "p1",
    expectedEverySeconds: 60 * 60,
    startGraceSeconds: 30 * 60,
    finishGraceSeconds: 15 * 60,
    queueBacklogGraceSeconds: 60 * 60,
    runbookUrl: OBS_RUNBOOK,
    alertChannels: ["webhook"],
    requiresFlag: "COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED",
  },
  {
    jobName: "accounting-invoice-correction",
    owner: "commerce/accounting",
    severity: "p2",
    expectedEverySeconds: 60 * 60,
    startGraceSeconds: 30 * 60,
    finishGraceSeconds: 15 * 60,
    queueBacklogGraceSeconds: 60 * 60,
    runbookUrl: OBS_RUNBOOK,
    alertChannels: ["webhook"],
    requiresFlag: "COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED",
  },
];
