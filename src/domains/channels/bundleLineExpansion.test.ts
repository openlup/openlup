import { describe, expect, it } from "vitest";
import {
  expandChannelBundleLines,
  orderCarriesBundleLines,
  type ChannelBundleComposition,
} from "./bundleLineExpansion.js";
import { normalizedChannelOrderSchema, type NormalizedChannelOrder } from "./orderContracts.js";

// The property these cases exist to hold is arithmetic, not shape: whatever the expansion produces
// must sum to the wire line it replaced, to the cent, for every quantity and every discount. The
// matrix below is deliberately rounding-hostile — prime quantities, weights that do not divide, and
// discounts small enough to fall below one cent per component — because those are the inputs where
// a proportional split is tempted to lose or invent money.

const composition: ChannelBundleComposition = {
  bundleCode: "starter",
  components: [
    { skuCode: "SKU-A", quantity: 1, referenceUnitPriceMinor: 1000 },
    { skuCode: "SKU-B", quantity: 1, referenceUnitPriceMinor: 700 },
    { skuCode: "SKU-C", quantity: 2, referenceUnitPriceMinor: 150 },
  ],
};

function order(line: {
  kind: "sku" | "bundle";
  code: string;
  quantity: number;
  unitGrossMinor: number;
  lineDiscountMinor: number;
}): NormalizedChannelOrder {
  const lineGrossMinor = line.unitGrossMinor * line.quantity;
  return normalizedChannelOrderSchema.parse({
    contractVersion: "channel.order.v1",
    channelSlug: "sim-market",
    externalOrderRef: "EXT-1",
    externalOrderRevision: null,
    providerEventId: "evt-1",
    placedAt: "2026-08-14T09:00:00Z",
    currency: "EUR",
    buyer: {
      externalCustomerRef: null,
      email: null,
      emailIsMasked: false,
      firstName: null,
      lastName: null,
      phone: null,
      taxId: null,
      companyName: null,
    },
    shipTo: {
      recipientName: "Buyer",
      line1: "Street 1",
      line2: null,
      postalCode: "10115",
      city: "Berlin",
      countryCode: "DE",
      phone: null,
      pickupPointRef: null,
    },
    lines: [
      {
        externalLineRef: "L1",
        sellable:
          line.kind === "bundle"
            ? { kind: "bundle", externalOfferRef: "OFFER-1", bundleCode: line.code }
            : { kind: "sku", externalOfferRef: "OFFER-1", skuCode: line.code },
        quantity: line.quantity,
        unitGrossMinor: line.unitGrossMinor,
        lineGrossMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        vatRateBps: 500,
      },
    ],
    shipping: { grossMinor: 0, discountMinor: 0, methodLabel: null, carrierHint: null },
    totals: {
      itemsGrossMinor: lineGrossMinor,
      itemsDiscountMinor: line.lineDiscountMinor,
      shippingGrossMinor: 0,
      shippingDiscountMinor: 0,
      grandTotalMinor: lineGrossMinor - line.lineDiscountMinor,
    },
    payment: {
      state: "paid_externally",
      externalPaymentRef: "PAY-1",
      paidAt: "2026-08-14T09:05:00Z",
      methodLabel: null,
    },
    payloadDigest: "digest-1",
  });
}

describe("channel bundle line expansion", () => {
  it("recognises which orders need expanding at all", () => {
    expect(orderCarriesBundleLines(order({ kind: "bundle", code: "starter", quantity: 1, unitGrossMinor: 1500, lineDiscountMinor: 0 }))).toBe(true);
    expect(orderCarriesBundleLines(order({ kind: "sku", code: "SKU-A", quantity: 1, unitGrossMinor: 1500, lineDiscountMinor: 0 }))).toBe(false);
  });

  it("passes a SKU line through untouched", () => {
    const result = expandChannelBundleLines(
      order({ kind: "sku", code: "SKU-A", quantity: 2, unitGrossMinor: 1000, lineDiscountMinor: 100 }),
      [composition],
    );
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.expanded).toBe(false);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      skuCode: "SKU-A",
      lineGrossMinor: 2000,
      lineDiscountMinor: 100,
      bundleCode: null,
      bundleQty: null,
    });
  });

  // quantity x unit price x discount, chosen so that both splits hit their remainder paths.
  const matrix = [
    { quantity: 1, unitGrossMinor: 1700, lineDiscountMinor: 0 },
    { quantity: 1, unitGrossMinor: 1700, lineDiscountMinor: 1 },
    { quantity: 1, unitGrossMinor: 1699, lineDiscountMinor: 7 },
    { quantity: 3, unitGrossMinor: 1667, lineDiscountMinor: 101 },
    { quantity: 7, unitGrossMinor: 1429, lineDiscountMinor: 3 },
    { quantity: 11, unitGrossMinor: 1901, lineDiscountMinor: 997 },
    { quantity: 13, unitGrossMinor: 999, lineDiscountMinor: 2 },
    { quantity: 2, unitGrossMinor: 2000, lineDiscountMinor: 0 },
  ];

  for (const scenario of matrix) {
    it(`keeps every cent for ${scenario.quantity} x ${scenario.unitGrossMinor} less ${scenario.lineDiscountMinor}`, () => {
      const wire = order({ kind: "bundle", code: "starter", ...scenario });
      const result = expandChannelBundleLines(wire, [composition]);
      expect(result.ok).toBe(true);
      if (result.ok === false) return;

      const gross = result.lines.reduce((carry, line) => carry + line.lineGrossMinor, 0);
      const discount = result.lines.reduce((carry, line) => carry + line.lineDiscountMinor, 0);
      expect(gross).toBe(wire.totals.itemsGrossMinor);
      expect(discount).toBe(wire.totals.itemsDiscountMinor);
      // The channel-final subtotal is the figure the allocator was actually given.
      expect(gross - discount).toBe(wire.lines[0].lineGrossMinor - wire.lines[0].lineDiscountMinor);
      // No component may carry a negative discount: the order-item CHECK refuses one outright.
      expect(result.lines.every((line) => line.lineDiscountMinor >= 0)).toBe(true);
      expect(result.lines.every((line) => line.lineGrossMinor >= line.lineDiscountMinor)).toBe(true);
      expect(result.lines.map((line) => line.skuCode)).toEqual(["SKU-A", "SKU-B", "SKU-C"]);
      expect(result.lines.map((line) => line.quantity)).toEqual([
        scenario.quantity,
        scenario.quantity,
        scenario.quantity * 2,
      ]);
      expect(result.lines.every((line) => line.bundleCode === "starter")).toBe(true);
      expect(result.lines.every((line) => line.bundleQty === scenario.quantity)).toBe(true);
      // Inherited, not re-derived: the bundle was sold as one taxable thing.
      expect(result.lines.every((line) => line.vatRateBps === 500)).toBe(true);
    });
  }

  it("is deterministic — the same wire line expands to the same cents twice", () => {
    const wire = order({ kind: "bundle", code: "starter", quantity: 3, unitGrossMinor: 1667, lineDiscountMinor: 101 });
    const first = expandChannelBundleLines(wire, [composition]);
    const second = expandChannelBundleLines(wire, [composition]);
    expect(first).toEqual(second);
  });

  it("refuses a bundle code this catalogue does not carry, naming the wire token", () => {
    const result = expandChannelBundleLines(
      order({ kind: "bundle", code: "not-here", quantity: 1, unitGrossMinor: 1700, lineDiscountMinor: 0 }),
      [composition],
    );
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal).toEqual({ kind: "unmapped_sellable", vocabulary: "not-here" });
  });

  it("refuses a component the catalogue prices nowhere", () => {
    const unpriced: ChannelBundleComposition = {
      bundleCode: "starter",
      components: [
        { skuCode: "SKU-A", quantity: 1, referenceUnitPriceMinor: 1000 },
        { skuCode: "SKU-B", quantity: 1, referenceUnitPriceMinor: null },
      ],
    };
    const result = expandChannelBundleLines(
      order({ kind: "bundle", code: "starter", quantity: 1, unitGrossMinor: 1500, lineDiscountMinor: 0 }),
      [unpriced],
    );
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("money_mismatch");
    expect(result.refusal.vocabulary).toBe("starter");
  });

  it("refuses a channel price the components cannot carry rather than inventing one", () => {
    // The marketplace sold it for more than the components are worth in this catalogue. That is a
    // pricing problem an operator fixes, not a number to round away.
    const result = expandChannelBundleLines(
      order({ kind: "bundle", code: "starter", quantity: 1, unitGrossMinor: 9_000, lineDiscountMinor: 0 }),
      [composition],
    );
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("money_mismatch");
    expect(String((result.refusal as { detail?: string }).detail)).toContain("TARGET_ABOVE_COMPONENT_SUM");
  });

  it("refuses a bundle with no components", () => {
    const result = expandChannelBundleLines(
      order({ kind: "bundle", code: "empty", quantity: 1, unitGrossMinor: 100, lineDiscountMinor: 0 }),
      [{ bundleCode: "empty", components: [] }],
    );
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.refusal.kind).toBe("money_mismatch");
  });
});
