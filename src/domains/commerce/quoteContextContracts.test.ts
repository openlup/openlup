import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_CURRENCY } from "../../lib/currency/platformCurrency.js";
import * as contracts from "./contracts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "./orderDraftSnapshotContracts.js";
import * as quoteContracts from "./quoteContracts.js";
import {
  quoteContextSchema,
  quoteCustomerEligibilityContextSchema,
  quotePetProfileContextSchema,
  quoteSizeConstraintSchema,
} from "./quoteContextContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

const CONTEXT = {
  mode: "subscription",
  cadenceDays: 21,
  sizeConstraint: { kind: "unit_count", value: 2 },
  promoCodes: [],
  petId: null,
};
const OFFER_EVIDENCE = { tier: "b", units: 2 };

describe("quote context contracts", () => {
  it("are the same schema objects through quoteContracts and contracts", () => {
    const moved = {
      quoteContextSchema,
      quoteCustomerEligibilityContextSchema,
      quotePetProfileContextSchema,
      quoteSizeConstraintSchema,
    };
    for (const [name, schema] of Object.entries(moved)) {
      expect(quoteContracts[name as keyof typeof moved], name).toBe(schema);
      expect(contracts[name as keyof typeof moved], name).toBe(schema);
    }
  });

  it("parses a context without offer fields deep-equal, adding no key", () => {
    const parsed = quoteContextSchema.parse(CONTEXT);

    expect(parsed).toEqual(CONTEXT);
    expect(Object.keys(parsed)).toEqual(Object.keys(CONTEXT));
  });

  it("accepts an offer version with its evidence, and a version alone", () => {
    expect(quoteContextSchema.parse({ ...CONTEXT, offerVersion: "offer.v2", offerEvidence: OFFER_EVIDENCE }))
      .toEqual({ ...CONTEXT, offerVersion: "offer.v2", offerEvidence: OFFER_EVIDENCE });
    expect(quoteContextSchema.safeParse({ ...CONTEXT, offerVersion: "offer.v2" }).success).toBe(true);
  });

  it("refuses evidence without a version", () => {
    const result = quoteContextSchema.safeParse({ ...CONTEXT, offerEvidence: OFFER_EVIDENCE });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining({
      message: "offerEvidence requires offerVersion",
      path: ["offerEvidence"],
    }));
  });

  it("refuses a malformed version, malformed evidence and an unknown context key", () => {
    expect(quoteContextSchema.safeParse({ ...CONTEXT, offerVersion: "Offer V2" }).success).toBe(false);
    expect(quoteContextSchema.safeParse({
      ...CONTEXT,
      offerVersion: "offer.v2",
      offerEvidence: { "not-an-identifier": true },
    }).success).toBe(false);
    expect(quoteContextSchema.safeParse({ ...CONTEXT, offerTier: "b" }).success).toBe(false);
  });

  it("lets the quote and the order-draft snapshot carry both offer fields", () => {
    const context = { ...CONTEXT, offerVersion: "offer.v2", offerEvidence: OFFER_EVIDENCE };
    const snapshot = contracts.createQuoteResponseSchema.parse(quoteWithContext(context));

    expect(snapshot.quote.context).toEqual(context);
    expect(createOrderDraftSnapshotFromQuoteSnapshot(snapshot).context).toEqual(context);
    expect(contracts.createQuoteResponseSchema.safeParse(
      quoteWithContext({ ...CONTEXT, offerEvidence: OFFER_EVIDENCE }),
    ).success).toBe(false);
  });
});

function quoteWithContext(context: Record<string, unknown>) {
  const money = (amountMinor: number) => ({ amountMinor, currency: PLATFORM_DEFAULT_CURRENCY });
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: PLATFORM_DEFAULT_CURRENCY,
      taxIncluded: true,
      lines: [{
        sku: "opaque:alpha.v1",
        productSlug: "alpha",
        quantity: 2,
        unitPriceGross: money(1_000),
        lineSubtotalGross: money(2_000),
        tax: {
          included: true,
          country: "ZZ",
          category: "standard",
          vatRateBps: 0,
          legalBasis: "example basis",
          netAmount: money(2_000),
          vatAmount: money(0),
          grossAmount: money(2_000),
        },
      }],
      discounts: [],
      context,
      subtotalGross: money(2_000),
      discountTotalGross: money(0),
      totalGross: money(2_000),
      netTotal: money(2_000),
      taxTotal: money(0),
    },
  };
}
