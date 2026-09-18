import { describe, expect, it } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { createQuoteResponseSchema, type CreateQuoteResponse } from "./contracts.js";
import {
  ORDER_DRAFT_SNAPSHOT_SOURCE,
  createOrderDraftSnapshotFromQuoteSnapshot,
  orderDraftSnapshotFromQuoteSnapshotSchema,
  orderDraftSnapshotSchema,
} from "./orderDraftSnapshotContracts.js";

describe("order draft snapshot contracts", () => {
  it("builds a shared draft snapshot from the quote snapshot", () => {
    const quoteSnapshot = quoteResponse();
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);

    expect(orderDraftSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.parse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }),
    ).toMatchObject({
      orderDraftSnapshot: {
        contractVersion: COMMERCE_CONTRACT_VERSION,
        source: ORDER_DRAFT_SNAPSHOT_SOURCE,
        status: "draft",
        paymentStatus: "not_started",
        totals: {
          subtotalGross: quoteSnapshot.quote.subtotalGross,
          discountTotalGross: quoteSnapshot.quote.discountTotalGross,
          totalGross: quoteSnapshot.quote.totalGross,
          netTotal: quoteSnapshot.quote.netTotal,
          taxTotal: quoteSnapshot.quote.taxTotal,
        },
      },
    });
    expect(snapshot.lines).toEqual(quoteSnapshot.quote.lines);
    expect(snapshot.context).toEqual(quoteSnapshot.quote.context);
    expect(snapshot.totals.totalGross).toEqual(quoteSnapshot.quote.totalGross);
  });

  it("rejects totals that do not match the quote lines", () => {
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteResponse());
    snapshot.totals.totalGross.amountMinor = 1;

    expect(orderDraftSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it("rejects a snapshot that no longer mirrors the quote snapshot", () => {
    const quoteSnapshot = quoteResponse();
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);
    snapshot.totals.netTotal.amountMinor = 1;

    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }).success,
    ).toBe(false);
  });

  it("rejects a snapshot whose lines no longer mirror the quote lines", () => {
    const quoteSnapshot = quoteResponse();
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);
    snapshot.lines[0].sku = "OPENLUP-DOG-BEEF-CAN-400G";

    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }).success,
    ).toBe(false);
  });

  it("rejects a snapshot whose hidden quote context no longer mirrors the quote", () => {
    const quoteSnapshot = quoteResponse();
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);
    snapshot.context = { ...snapshot.context, cadenceDays: 28 };

    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }).success,
    ).toBe(false);
  });

  it("accepts a discounted quote and its mirrored order-draft snapshot", () => {
    const quoteSnapshot = discountedQuoteResponse();

    // The quote schema itself now admits a non-empty discount with reconciled totals.
    expect(createQuoteResponseSchema.safeParse(quoteSnapshot).success).toBe(true);

    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);
    expect(orderDraftSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.discounts).toEqual(quoteSnapshot.quote.discounts);
    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }).success,
    ).toBe(true);
  });

  it("rejects a discounted quote whose discount lines do not sum to discountTotal", () => {
    const quoteSnapshot = discountedQuoteResponse();
    quoteSnapshot.quote.discounts[0].amountOffMinor = 1000; // != discountTotalGross (1490)

    expect(createQuoteResponseSchema.safeParse(quoteSnapshot).success).toBe(false);
  });

  it("accepts a free-shipping quote without double-counting the shipping discount", () => {
    // Regression: a `shipping` discount lives in `discounts[]` but is NOT part of
    // `discountTotalGross`. The old refine summed every discount and rejected the
    // mirrored snapshot, 503-ing every shipping-discounted checkout.
    const quoteSnapshot = freeShippingQuoteResponse();
    expect(createQuoteResponseSchema.safeParse(quoteSnapshot).success).toBe(true);

    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot);
    expect(orderDraftSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.totals.shippingGross).toEqual(quoteSnapshot.quote.shippingGross);
    expect(snapshot.totals.shippingDiscountGross).toEqual(quoteSnapshot.quote.shippingDiscountGross);
    expect(snapshot.discounts).toEqual(quoteSnapshot.quote.discounts);
    expect(
      orderDraftSnapshotFromQuoteSnapshotSchema.safeParse({
        quoteSnapshot,
        orderDraftSnapshot: snapshot,
      }).success,
    ).toBe(true);
  });

  it("rejects a snapshot whose shipping discount does not reconcile", () => {
    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(freeShippingQuoteResponse());
    snapshot.totals.shippingDiscountGross = { amountMinor: 900, currency: "PLN" };

    expect(orderDraftSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});

function freeShippingQuoteResponse(): CreateQuoteResponse {
  // Shipping costs 1500 but is fully discounted (free shipping): the shipping lane
  // nets to zero, so subtotal/total/net/tax are byte-identical to the no-shipping
  // base; only the shipping discount entry + the shipping totals differ.
  const base = quoteResponse();
  base.quote.shippingGross = { amountMinor: 1500, currency: "PLN" };
  base.quote.shippingDiscountGross = { amountMinor: 1500, currency: "PLN" };
  base.quote.discounts = [
    {
      promotionId: "promo-free-shipping",
      code: null,
      label: "Free shipping",
      appliesTo: "shipping",
      amountOffMinor: 1500,
      reasonCode: "free_shipping",
    },
  ];
  return base;
}

function discountedQuoteResponse(): CreateQuoteResponse {
  // −50% order discount on the 2980 subtotal: total 1490; the discount's included-VAT
  // split is vat=round(1490*8/108)=110, net=1380, so net/tax = line(2759/221) − (1380/110).
  const base = quoteResponse();
  base.quote.discounts = [
    {
      promotionId: "promo-first-sub-50",
      code: null,
      label: "First subscription −50%",
      appliesTo: "order_total",
      amountOffMinor: 1490,
      reasonCode: "first_subscription_order",
    },
  ];
  base.quote.discountTotalGross = { amountMinor: 1490, currency: "PLN" };
  base.quote.totalGross = { amountMinor: 1490, currency: "PLN" };
  base.quote.netTotal = { amountMinor: 1379, currency: "PLN" };
  base.quote.taxTotal = { amountMinor: 111, currency: "PLN" };
  return base;
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          productSlug: "lamb",
          quantity: 2,
          unitPriceGross: { amountMinor: 1490, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 2980, currency: "PLN" },
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 2759, currency: "PLN" },
            vatAmount: { amountMinor: 221, currency: "PLN" },
            grossAmount: { amountMinor: 2980, currency: "PLN" },
          },
        },
      ],
      discounts: [],
      context: {
        mode: "subscription",
        cadenceDays: 21,
        sizeConstraint: {
          kind: "feeding_days",
          value: 21,
          petId: "pet-rex",
          dailyKcalOverride: 328,
        },
        promoCodes: [],
        petId: "pet-rex",
        petProfileContext: {
          petId: "pet-rex",
          ageBand: "adult",
          weightKg: 12,
          activityLevel: "normal",
          bcs: "ideal",
          allergenSlugs: ["chicken"],
          dailyKcalOverride: 328,
        },
      },
      subtotalGross: { amountMinor: 2980, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 2980, currency: "PLN" },
      netTotal: { amountMinor: 2759, currency: "PLN" },
      taxTotal: { amountMinor: 221, currency: "PLN" },
    },
  };
}
