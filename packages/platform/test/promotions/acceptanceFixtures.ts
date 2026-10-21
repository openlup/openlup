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
          sku: "opaque:item-alpha.v1",
          productSlug: "item-alpha",
          quantity: 1,
          unitPriceGross: totalGross,
          lineSubtotalGross: totalGross,
          tax: {
            included: true,
            country: "ZZ",
            category: "example_category",
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
  return { mode: "one_time", lines: [{ sku: "opaque:item-alpha.v1", quantity: 14, variantId: "variant-item-alpha-400", modeAtLine: "one_time" }],
    sizeConstraint: { kind: "usage_days", value: 21, dailyUsageOverride: 328 }, cadenceDays: null,
    promoCodes: ["SAVE80"], visitorId: "visitor-1", customerEligibilityContext: { email: "subject-a@example.com" } };
}
