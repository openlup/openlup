import { describe, expect, it } from "vitest";
import { PROMOTION_JOB_CATALOG } from "./jobCatalogPromotions";

describe("promotion job catalog", () => {
  it("monitors the five-minute claim sweep only when its mutation flag is active", () => {
    expect(PROMOTION_JOB_CATALOG).toEqual([expect.objectContaining({
      jobName: "promotion-claim-sweep",
      expectedEverySeconds: 300,
      startGraceSeconds: 600,
      finishGraceSeconds: 300,
      severity: "p2",
      requiresFlag: "COMMERCE_PROMOTION_CLAIM_SWEEP_ENABLED",
    })]);
  });
});
