import { describe, expect, it } from "vitest";

import { parsePromotionClaimSweepCounts } from "./promotionClaimSweepPort.js";

describe("promotion claim sweep contract", () => {
  it("accepts the neutral bounded-sweep counters", () => {
    expect(parsePromotionClaimSweepCounts({
      checked: 5,
      cancelled: 2,
      skipped: 3,
    })).toEqual({ checked: 5, cancelled: 2, skipped: 3 });
  });

  it.each([
    null,
    {},
    { checked: 1, cancelled: 0 },
    { checked: 1.5, cancelled: 0, skipped: 0 },
    { checked: 1, cancelled: "0", skipped: 0 },
  ])("fails closed on malformed sweep evidence: %j", (value) => {
    expect(() => parsePromotionClaimSweepCounts(value))
      .toThrow("promotion_claim_sweep_invalid_response");
  });
});
