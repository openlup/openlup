import type { JobCatalogEntry } from "./observabilityContracts.js";

export const PROMOTION_JOB_CATALOG: readonly JobCatalogEntry[] = [{
  jobName: "promotion-claim-sweep",
  owner: "commerce/promotions",
  severity: "p2",
  expectedEverySeconds: 5 * 60,
  startGraceSeconds: 10 * 60,
  finishGraceSeconds: 5 * 60,
  runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
  alertChannels: ["webhook"],
  requiresFlag: "COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED",
}];
