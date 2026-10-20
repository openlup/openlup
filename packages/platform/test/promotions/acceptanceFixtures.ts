import type { CreateQuoteResponse, CreateQuoteRequest } from "../pricing/quoteSchemaFixtures.js";
export function quoteSnapshot(
  totalGross: CreateQuoteResponse["quote"]["totalGross"] = { amountMinor: 1490, currency: "XXX" },
): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "XXX",
      taxIncluded: true,
      lines: [
        {
          sku: "opaque:lamb-launch.v1",
          productSlug: "lamb",
          quantity: 1,
          unitPriceGross: totalGross,
          lineSubtotalGross: totalGross,
          tax: {
            included: true,
            country: "ZZ",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "Example VAT rule",
            netAmount: { amountMinor: Math.round((totalGross.amountMinor * 100) / 108), currency: "XXX" },
            vatAmount: {
              amountMinor:
                totalGross.amountMinor - Math.round((totalGross.amountMinor * 100) / 108),
              currency: "XXX",
            },
            grossAmount: totalGross,
          },
        },
      ],
      discounts: [],
      subtotalGross: totalGross,
      discountTotalGross: { amountMinor: 0, currency: "XXX" },
      totalGross,
      netTotal: { amountMinor: Math.round((totalGross.amountMinor * 100) / 108), currency: "XXX" },
      taxTotal: {
        amountMinor: totalGross.amountMinor - Math.round((totalGross.amountMinor * 100) / 108),
        currency: "XXX",
      },
    },
  };
}


export function acceptanceRequest(): CreateQuoteRequest {
  return { mode: "one_time", lines: [{ sku: "opaque:lamb-launch.v1", quantity: 14, variantId: "variant-lamb-400", modeAtLine: "one_time" }],
    sizeConstraint: { kind: "feeding_days", value: 21, dailyKcalOverride: 328 }, cadenceDays: null,
    promoCodes: ["SAVE80"], visitorId: "visitor-1", customerEligibilityContext: { email: "anna@example.com" } };
}
