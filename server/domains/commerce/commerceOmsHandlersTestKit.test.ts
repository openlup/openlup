import { describe, expect, it } from "vitest";
import { listResponse } from "./commerceOmsHandlersTestKit.js";

describe("commerce OMS handlers test kit", () => {
  it("includes additive summary totals in list fixtures", () => {
    expect(listResponse().summaryTotals).toEqual({
      gmv: { amountMinor: 12900, currency: "PLN" },
      aov: { amountMinor: 12900, currency: "PLN" },
      orderCount: 1,
      paidSubscriptionCycleCount: 0,
    });
  });
});
