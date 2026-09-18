import { describe, expect, it } from "vitest";
import { quoteLineSchema } from "../../../src/domains/commerce/contracts.js";
import {
  assertSingleVatRate,
  buildOrderSnapshot,
  buildPricingSnapshot,
  money,
} from "./subscriptionCycleOrderTotals.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const SCHEDULED_AT = "2026-06-09T12:00:00Z";

function quoteLine(opts: {
  sku?: string;
  unitPriceMinor?: number;
  quantity?: number;
  vatRateBps?: number;
} = {}) {
  const sku = opts.sku ?? "VEL-LAMB-01";
  const quantity = opts.quantity ?? 2;
  const unitPriceMinor = opts.unitPriceMinor ?? 4900;
  const vatRateBps = opts.vatRateBps ?? 800;
  const subtotalMinor = unitPriceMinor * quantity;
  const netMinor = Math.round((subtotalMinor * 10000) / (10000 + vatRateBps));
  const vatMinor = subtotalMinor - netMinor;
  return quoteLineSchema.parse({
    sku,
    productSlug: "lamb",
    quantity,
    unitPriceGross: { amountMinor: unitPriceMinor, currency: "PLN" },
    lineSubtotalGross: { amountMinor: subtotalMinor, currency: "PLN" },
    tax: {
      included: true,
      country: "PL",
      category: vatRateBps === 800 ? "pet_food" : "standard",
      vatRateBps,
      legalBasis: vatRateBps === 800 ? "PL VAT Annex 3 item 10c" : "PL VAT standard rate",
      netAmount: { amountMinor: netMinor, currency: "PLN" },
      vatAmount: { amountMinor: vatMinor, currency: "PLN" },
      grossAmount: { amountMinor: subtotalMinor, currency: "PLN" },
    },
  });
}

// The exact objects the builders produced BEFORE they were moved out of
// buildSubscriptionCycleSnapshots.ts, for the single-line 2 x 4900 fixture that
// buildSubscriptionCycleSnapshots.test.ts already pins (9800 gross, 9074 net,
// 726 VAT at 800 bps). Deep-equality against these is the extraction proof.
function expectedOrderSnapshot(line: ReturnType<typeof quoteLine>) {
  return {
    contractVersion: "commerce.v0",
    source: "subscription.own_engine.v0",
    status: "pending_payment",
    paymentStatus: "pending",
    currency: "PLN",
    taxIncluded: true,
    lines: [line],
    totals: {
      subtotalGross: { amountMinor: 9800, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 9800, currency: "PLN" },
      netTotal: { amountMinor: 9074, currency: "PLN" },
      taxTotal: { amountMinor: 726, currency: "PLN" },
    },
  };
}

describe("buildOrderSnapshot without a discount reproduces the pre-extraction output", () => {
  it("deep-equals the pre-extraction object when the discount is omitted", () => {
    const line = quoteLine();
    expect(buildOrderSnapshot({ currency: "PLN", lines: [line] })).toEqual(
      expectedOrderSnapshot(line),
    );
  });

  it("treats null and 0 exactly like an omitted discount, key order included", () => {
    const line = quoteLine();
    const omitted = buildOrderSnapshot({ currency: "PLN", lines: [line] });
    const nulled = buildOrderSnapshot({
      currency: "PLN",
      lines: [line],
      discountTotalGrossMinor: null,
    });
    const zeroed = buildOrderSnapshot({
      currency: "PLN",
      lines: [line],
      discountTotalGrossMinor: 0,
    });
    expect(JSON.stringify(nulled)).toBe(JSON.stringify(omitted));
    expect(JSON.stringify(zeroed)).toBe(JSON.stringify(omitted));
  });

  it("rejects a non-PLN currency with the original message", () => {
    expect(() => buildOrderSnapshot({ currency: "EUR", lines: [quoteLine()] })).toThrow(
      /Unsupported currency for subscription cycle snapshot: EUR/,
    );
  });

  it("sums multiple lines into the totals", () => {
    const lines = [
      quoteLine({ sku: "VEL-LAMB-01", quantity: 5, unitPriceMinor: 4900 }),
      quoteLine({ sku: "VEL-BEEF-01", quantity: 3, unitPriceMinor: 5100 }),
    ];
    const totals = buildOrderSnapshot({ currency: "PLN", lines }).totals as Record<
      string,
      { amountMinor: number }
    >;
    expect(totals.subtotalGross.amountMinor).toBe(5 * 4900 + 3 * 5100);
    expect(totals.totalGross.amountMinor).toBe(totals.subtotalGross.amountMinor);
    expect(totals.netTotal.amountMinor + totals.taxTotal.amountMinor).toBe(
      totals.subtotalGross.amountMinor,
    );
  });
});

describe("buildOrderSnapshot with an order-level discount", () => {
  it("splits the tax-inclusive discount at the single line VAT rate", () => {
    // 9800 gross at 800 bps; a 35% starter discount is 3430 gross.
    // 3430 net = round(3430 * 10000 / 10800) = 3176, so 254 is VAT.
    const totals = buildOrderSnapshot({
      currency: "PLN",
      lines: [quoteLine()],
      discountTotalGrossMinor: 3430,
    }).totals as Record<string, { amountMinor: number; currency: string }>;

    expect(totals).toEqual({
      subtotalGross: { amountMinor: 9800, currency: "PLN" },
      discountTotalGross: { amountMinor: 3430, currency: "PLN" },
      totalGross: { amountMinor: 6370, currency: "PLN" },
      netTotal: { amountMinor: 5898, currency: "PLN" },
      taxTotal: { amountMinor: 472, currency: "PLN" },
    });
    // The same reconciliation the cycle-order RPC performs.
    expect(totals.netTotal.amountMinor + totals.taxTotal.amountMinor).toBe(
      totals.totalGross.amountMinor,
    );
    expect(totals.totalGross.amountMinor).toBe(
      totals.subtotalGross.amountMinor - totals.discountTotalGross.amountMinor,
    );
  });

  it("accepts a discount equal to the whole subtotal", () => {
    const totals = buildOrderSnapshot({
      currency: "PLN",
      lines: [quoteLine()],
      discountTotalGrossMinor: 9800,
    }).totals as Record<string, { amountMinor: number }>;
    expect(totals.totalGross.amountMinor).toBe(0);
    expect(totals.netTotal.amountMinor).toBe(0);
    expect(totals.taxTotal.amountMinor).toBe(0);
  });

  it("throws on mixed VAT rates before the RPC could see them", () => {
    expect(() =>
      buildOrderSnapshot({
        currency: "PLN",
        lines: [quoteLine(), quoteLine({ sku: "VEL-TREAT-01", vatRateBps: 2300 })],
        discountTotalGrossMinor: 1000,
      }),
    ).toThrow(/single VAT rate, found \[800, 2300\]/);
  });

  it("throws when the discount exceeds the subtotal", () => {
    expect(() =>
      buildOrderSnapshot({
        currency: "PLN",
        lines: [quoteLine()],
        discountTotalGrossMinor: 9801,
      }),
    ).toThrow(/discount 9801 exceeds subtotal 9800/);
  });

  it("throws on a negative or fractional discount", () => {
    for (const discountTotalGrossMinor of [-1, 12.5]) {
      expect(() =>
        buildOrderSnapshot({ currency: "PLN", lines: [quoteLine()], discountTotalGrossMinor }),
      ).toThrow(/non-negative integer minor amount/);
    }
  });

  it("is deterministic across repeated builds", () => {
    const build = () =>
      buildOrderSnapshot({
        currency: "PLN",
        lines: [quoteLine(), quoteLine({ sku: "VEL-BEEF-01", unitPriceMinor: 5100 })],
        discountTotalGrossMinor: 4000,
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    expect(build()).toEqual(build());
  });
});

describe("assertSingleVatRate", () => {
  it("returns the shared rate and names the rates when they differ", () => {
    expect(assertSingleVatRate([quoteLine(), quoteLine({ sku: "VEL-BEEF-01" })])).toBe(800);
    expect(() => assertSingleVatRate([])).toThrow(/single VAT rate, found \[\]/);
  });
});

describe("buildPricingSnapshot", () => {
  const totals = { subtotalGross: money(9800, "PLN") };

  it("omits provenance entirely when none is supplied", () => {
    const snapshot = buildPricingSnapshot({
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
      cycleNumber: 3,
      totals,
    });
    expect(snapshot).toEqual({
      contractVersion: "commerce.v0",
      source: "subscription.own_engine.v0",
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
      cycleNumber: 3,
      totals,
    });
    expect(Object.keys(snapshot)).not.toContain("provenance");
    expect(
      JSON.stringify(
        buildPricingSnapshot({
          subscriptionId: SUB_ID,
          scheduledAt: SCHEDULED_AT,
          cycleNumber: 3,
          totals,
          provenance: null,
        }),
      ),
    ).toBe(JSON.stringify(snapshot));
  });

  it("carries a starter-pack provenance block with no timestamp in it", () => {
    const provenance = {
      starterPack: {
        reasonCode: "starter_pack_delivery_2",
        discountMinor: 3430,
        basisTemplateVersion: 1,
      },
    };
    const snapshot = buildPricingSnapshot({
      subscriptionId: SUB_ID,
      scheduledAt: SCHEDULED_AT,
      cycleNumber: 2,
      totals,
      provenance,
    });
    expect(snapshot.provenance).toEqual(provenance);
    expect(JSON.stringify(snapshot)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});
