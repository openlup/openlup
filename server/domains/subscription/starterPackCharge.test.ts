import { describe, expect, it } from "vitest";
import {
  quoteLinesListAnchorMinor,
  retriedStarterDiscountMinor,
  upcomingCycleNumber,
  resolveStarterDelivery2Discount,
  resolveStarterUpcomingCharge,
  starterGraduationTotals,
} from "./starterPackCharge.js";
import { starterPackMarkerSchema, type StarterPackMarker } from "./starterPackCycle.js";

const BASIS = 1;

function marker(overrides: Record<string, unknown> = {}): StarterPackMarker {
  return starterPackMarkerSchema.parse({
    schemaVersion: "1",
    starterIntervalDays: 17,
    basisTemplateVersion: BASIS,
    delivery2: { discountBps: 3500, discountMinor: 3430, basisSubtotalMinor: 9800 },
    graduation: {
      cadenceDays: 28,
      lines: [
        {
          sku: "VEL-LAMB-01",
          qty: 8,
          sortOrder: 0,
          isAddon: false,
          quoteLine: {
            unitPriceGross: { amountMinor: 1340, currency: "EUR" },
            lineSubtotalGross: { amountMinor: 10720, currency: "EUR" },
          },
        },
      ],
    },
    ...overrides,
  });
}

/**
 * Worked example: 15 cans, list 1 490 each (22 350), band 1 340 each (20 100).
 * Checkout froze delivery 2 at 65% of list = 14 528, i.e. a 5 572 discount off
 * the band subtotal. 35% of the band subtotal would be 7 035.
 */
const WORKED_EXAMPLE = marker({
  starterIntervalDays: 7,
  delivery2: { discountBps: 3500, discountMinor: 5572, basisSubtotalMinor: 20100 },
});

describe("resolveStarterDelivery2Discount", () => {
  it("uses the frozen amount when the subtotal is the checkout basis", () => {
    expect(
      resolveStarterDelivery2Discount({ marker: marker(), subtotalMinor: 9800, listAnchorMinor: null }),
    ).toEqual({ discountMinor: 3430, basis: "frozen" });
  });

  it("keeps the frozen 65%-of-list amount for an unchanged package, whatever the list anchor says", () => {
    const result = resolveStarterDelivery2Discount({
      marker: WORKED_EXAMPLE,
      subtotalMinor: 20100,
      listAnchorMinor: 22350,
    });
    expect(result).toEqual({ discountMinor: 5572, basis: "frozen" });
    expect(20100 - result.discountMinor).toBe(14528);
  });

  it("prices a changed composition at 65% of its list, never 35% off the band price", () => {
    // Edited to 20 cans: band 26 800, list 29 800 -> ceil(0.65 x 29 800) = 19 370.
    const result = resolveStarterDelivery2Discount({
      marker: WORKED_EXAMPLE,
      subtotalMinor: 26800,
      listAnchorMinor: 29800,
    });
    expect(result).toEqual({ discountMinor: 26800 - 19370, basis: "list_anchor" });
    // The old formula took 35% of the band subtotal: 9 380 off -> 17 420,
    // i.e. 41.5% off list instead of the promised 35%.
    expect(result.discountMinor).toBeLessThan(Math.round(26800 * 0.35));
  });

  it("rounds the 65% target up, as checkout does", () => {
    // ceil(0.65 x 10 001) = ceil(6500.65) = 6501.
    expect(
      resolveStarterDelivery2Discount({ marker: marker(), subtotalMinor: 9001, listAnchorMinor: 10001 }),
    ).toEqual({ discountMinor: 9001 - 6501, basis: "list_anchor" });
  });

  it("never charges above the band price when the band is already below 65% of list", () => {
    expect(
      resolveStarterDelivery2Discount({ marker: marker(), subtotalMinor: 4000, listAnchorMinor: 7000 }),
    ).toEqual({ discountMinor: 0, basis: "list_anchor" });
  });

  it("falls back to the band rate when a line carries no list evidence", () => {
    // 12000 * 3500 / 10000 = 4200.
    expect(
      resolveStarterDelivery2Discount({ marker: marker(), subtotalMinor: 12_000, listAnchorMinor: null }),
    ).toEqual({ discountMinor: 4200, basis: "band_rate_fallback" });
  });

  it("clamps so at least 100 minor units remain payable", () => {
    expect(
      resolveStarterDelivery2Discount({
        marker: marker({ delivery2: { discountBps: 10_000, discountMinor: 0, basisSubtotalMinor: 1 } }),
        subtotalMinor: 500,
        listAnchorMinor: null,
      }).discountMinor,
    ).toBe(400);
  });

  it("clamps to zero rather than negative when the subtotal is below the floor", () => {
    expect(
      resolveStarterDelivery2Discount({
        marker: marker({ delivery2: { discountBps: 5000, discountMinor: 0, basisSubtotalMinor: 1 } }),
        subtotalMinor: 50,
        listAnchorMinor: 60,
      }).discountMinor,
    ).toBe(0);
  });

  it("returns an integer for a rate that does not divide evenly", () => {
    const { discountMinor } = resolveStarterDelivery2Discount({
      marker: marker({ delivery2: { discountBps: 3333, discountMinor: 0, basisSubtotalMinor: 1 } }),
      subtotalMinor: 9801,
      listAnchorMinor: null,
    });
    expect(discountMinor).toBe(Math.round((9801 * 3333) / 10_000));
  });
});

describe("retried cycles", () => {
  const stored = (discountMinor: unknown, reasonCode = "starter_pack_delivery_2") => ({
    provenance: { starterPack: { reasonCode, discountMinor, basisTemplateVersion: BASIS } },
  });

  it("reads the delivery-2 discount a cycle was first priced with", () => {
    expect(retriedStarterDiscountMinor(stored(7035))).toBe(7035);
    expect(retriedStarterDiscountMinor(stored(0))).toBe(0);
  });

  it("is null for a snapshot without delivery-2 provenance or with a malformed amount", () => {
    expect(retriedStarterDiscountMinor(undefined)).toBeNull();
    expect(retriedStarterDiscountMinor({})).toBeNull();
    expect(retriedStarterDiscountMinor(stored(7035, "something_else"))).toBeNull();
    expect(retriedStarterDiscountMinor(stored(-1))).toBeNull();
    expect(retriedStarterDiscountMinor(stored(12.5))).toBeNull();
    expect(retriedStarterDiscountMinor(stored("7035"))).toBeNull();
  });

  it("keeps the stored discount over every current rule, so the retry's snapshot is unchanged", () => {
    // An earlier rule stored 7 035 (35% of the band subtotal) on an unchanged package;
    // today's rule would say 5 572, and a different amount would fail the retry.
    expect(
      resolveStarterDelivery2Discount({
        marker: WORKED_EXAMPLE,
        subtotalMinor: 20100,
        listAnchorMinor: 22350,
        retriedCycleDiscountMinor: 7035,
      }),
    ).toEqual({ discountMinor: 7035, basis: "retried_cycle" });
  });

  it("still clamps a stored discount to leave the minimum payable", () => {
    expect(
      resolveStarterDelivery2Discount({
        marker: marker(),
        subtotalMinor: 500,
        listAnchorMinor: null,
        retriedCycleDiscountMinor: 9999,
      }).discountMinor,
    ).toBe(400);
  });
});

describe("quoteLinesListAnchorMinor", () => {
  const line = (listMinor: number) => ({
    pricingComponents: [
      { componentType: "base_unit", amountMinor: listMinor },
      { componentType: "mode_discount", amountMinor: -150 },
    ],
  });

  it("sums the base_unit components of every line", () => {
    expect(quoteLinesListAnchorMinor([line(4470), line(4470), line(2980)])).toBe(11920);
  });

  it("is null when any line carries no base_unit component", () => {
    expect(quoteLinesListAnchorMinor([line(4470), { pricingComponents: [] }])).toBeNull();
    expect(quoteLinesListAnchorMinor([line(4470), {}])).toBeNull();
    expect(quoteLinesListAnchorMinor([line(4470), null])).toBeNull();
  });

  it("counts a free line (zero list price) as evidence, not as missing", () => {
    expect(quoteLinesListAnchorMinor([line(4470), line(0)])).toBe(4470);
  });

  it("is null for no lines at all", () => {
    expect(quoteLinesListAnchorMinor([])).toBeNull();
  });
});

describe("upcomingCycleNumber", () => {
  it("is the highest existing number + 1 when every cycle is settled", () => {
    expect(upcomingCycleNumber([{ cycleNumber: 1, status: "paid" }, { cycleNumber: 2, status: "paid" }])).toBe(3);
    expect(upcomingCycleNumber([])).toBe(1);
  });

  it("is the open cycle's own number, because the engine re-drives that cycle", () => {
    // A declined delivery 2 is retried as delivery 2, not skipped to delivery 3.
    expect(
      upcomingCycleNumber([{ cycleNumber: 1, status: "paid" }, { cycleNumber: 2, status: "retry_scheduled" }]),
    ).toBe(2);
    for (const status of ["planned", "payment_pending", "payment_failed"]) {
      expect(upcomingCycleNumber([{ cycleNumber: 1, status: "paid" }, { cycleNumber: 2, status }])).toBe(2);
    }
  });

  it("does not depend on the order the rows arrive in", () => {
    const rows = [
      { cycleNumber: 3, status: "retry_scheduled" },
      { cycleNumber: 1, status: "paid" },
      { cycleNumber: 2, status: "payment_failed" },
    ];
    expect(upcomingCycleNumber(rows)).toBe(2);
    expect(upcomingCycleNumber([...rows].reverse())).toBe(2);
  });

  it("ignores a terminalized cycle", () => {
    expect(
      upcomingCycleNumber([{ cycleNumber: 1, status: "paid" }, { cycleNumber: 2, status: "cancelled" }]),
    ).toBe(3);
  });
});

describe("resolveStarterUpcomingCharge", () => {
  const unchanged = { subtotalMinor: 20100, listAnchorMinor: 22350 };

  it("states delivery 2 at the frozen amount for an unchanged package", () => {
    expect(
      resolveStarterUpcomingCharge({
        marker: WORKED_EXAMPLE,
        templateVersion: BASIS,
        cadenceDays: 7,
        cycleNumber: 2,
        currentLines: unchanged,
      }),
    ).toEqual({
      stage: "delivery2",
      subtotalMinor: 20100,
      discountMinor: 5572,
      totalMinor: 14528,
      delivery2Basis: "frozen",
    });
  });

  it("keeps the frozen amount after a win-back reactivation bumped the version", () => {
    expect(
      resolveStarterUpcomingCharge({
        marker: WORKED_EXAMPLE,
        templateVersion: BASIS + 1,
        cadenceDays: 7,
        cycleNumber: 2,
        currentLines: unchanged,
      })?.totalMinor,
    ).toBe(14528);
  });

  it("states the graduation at the frozen steady package", () => {
    expect(
      resolveStarterUpcomingCharge({
        marker: marker(),
        templateVersion: BASIS,
        cadenceDays: 17,
        cycleNumber: 3,
        currentLines: { subtotalMinor: 9800, listAnchorMinor: null },
      }),
    ).toEqual({
      stage: "graduation",
      subtotalMinor: 10720,
      discountMinor: 0,
      totalMinor: 10720,
      delivery2Basis: null,
    });
  });

  it("is null when the starter pack does not price the cycle", () => {
    const base = { templateVersion: BASIS, cadenceDays: 17, currentLines: unchanged };
    expect(resolveStarterUpcomingCharge({ ...base, marker: null, cycleNumber: 2 })).toBeNull();
    expect(resolveStarterUpcomingCharge({ ...base, marker: marker(), cycleNumber: 1 })).toBeNull();
    // A graduation that keeps the customer's own lines charges those lines.
    expect(
      resolveStarterUpcomingCharge({ ...base, marker: marker(), templateVersion: BASIS + 1, cycleNumber: 3 }),
    ).toBeNull();
    // After graduation the subscription is ordinary.
    expect(
      resolveStarterUpcomingCharge({ ...base, marker: marker(), templateVersion: BASIS + 1, cadenceDays: 28, cycleNumber: 4 }),
    ).toBeNull();
  });
});

describe("starterGraduationTotals", () => {
  it("is null rather than a partial sum when a frozen line has no subtotal", () => {
    const broken = marker();
    broken.graduation.lines[0].quoteLine = {};
    expect(starterGraduationTotals(broken)).toBeNull();
  });
});
