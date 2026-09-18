import { describe, expect, it } from "vitest";
import { latestSuccessfulOmnipackStateConflictCount } from "./observabilityReconciliationEvidence.js";

describe("reconciliation observability queries", () => {
  it("uses the newest successful OmniPack run as the conflict lifecycle source", () => {
    expect(latestSuccessfulOmnipackStateConflictCount([
      { job_name: "omnipack-reconciliation", status: "failed", metadata: { stateConflicts: 99 } },
      { job_name: "omnipack-reconciliation", status: "success", metadata: { stateConflicts: 2 } },
      { job_name: "omnipack-reconciliation", status: "success", metadata: { stateConflicts: 7 } },
    ])).toBe(2);
  });

  it("fails closed to zero for malformed metadata", () => {
    expect(latestSuccessfulOmnipackStateConflictCount([
      { job_name: "omnipack-reconciliation", status: "success", metadata: { stateConflicts: -1 } },
    ])).toBe(0);
  });
});
