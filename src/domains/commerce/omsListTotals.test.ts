import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_CURRENCY } from "../../lib/currency/platformCurrency.js";
import type { AdminCommerceOrdersListResponse } from "./omsContracts.js";
import { CommerceOmsMixedCurrencyTotalsError, summarizeOmsListTotals } from "./omsListTotals.js";

type ListOrder = AdminCommerceOrdersListResponse["orders"][number];

const OTHER_CURRENCY = "EUR";

// The summariser reads three fields. Carrying only those keeps the fixture from
// asserting anything about the rest of the list contract.
function order(
  paymentStatus: string,
  amountMinor: number,
  currency: string,
  mode: string = "one_time",
): ListOrder {
  return { paymentStatus, mode, total: { amountMinor, currency } } as unknown as ListOrder;
}

describe("commerce OMS list totals", () => {
  it("keeps the single-currency numbers and counts only paid orders", () => {
    const totals = summarizeOmsListTotals([
      order("succeeded", 10000, PLATFORM_DEFAULT_CURRENCY),
      order("succeeded", 20500, PLATFORM_DEFAULT_CURRENCY, "subscription_cycle"),
      order("processing", 99900, PLATFORM_DEFAULT_CURRENCY),
    ]);

    expect(totals).toEqual({
      gmv: { amountMinor: 30500, currency: PLATFORM_DEFAULT_CURRENCY },
      aov: { amountMinor: 15250, currency: PLATFORM_DEFAULT_CURRENCY },
      orderCount: 2,
      paidSubscriptionCycleCount: 1,
    });
  });

  it("labels an empty paid set with the platform default rather than the first order's currency", () => {
    const totals = summarizeOmsListTotals([order("processing", 99900, OTHER_CURRENCY)]);

    expect(totals.gmv).toEqual({ amountMinor: 0, currency: PLATFORM_DEFAULT_CURRENCY });
    expect(totals.aov).toEqual({ amountMinor: 0, currency: PLATFORM_DEFAULT_CURRENCY });
    expect(totals.orderCount).toBe(0);
  });

  it("refuses a paid set that spans two currencies instead of summing across them", () => {
    const mixed = [
      order("succeeded", 10000, OTHER_CURRENCY),
      order("succeeded", 20500, PLATFORM_DEFAULT_CURRENCY),
    ];

    expect(() => summarizeOmsListTotals(mixed)).toThrow(CommerceOmsMixedCurrencyTotalsError);
    try {
      summarizeOmsListTotals(mixed);
      expect.unreachable("the mixed-currency set must not produce a total");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceOmsMixedCurrencyTotalsError);
      expect((error as CommerceOmsMixedCurrencyTotalsError).currencies).toEqual(
        [OTHER_CURRENCY, PLATFORM_DEFAULT_CURRENCY].sort(),
      );
      expect((error as Error).message).toBe("commerce_oms_summary_mixed_currency");
    }
  });
});
