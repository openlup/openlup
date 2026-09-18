import { describe, expect, it } from "vitest";
import {
  commerceQuoteSchema,
  createQuoteResponseSchema,
  publicCreateQuoteBatchResponseSchema,
  publicCreateQuoteResponseSchema,
  quoteDiscountSchema,
  quoteMoneyCurrenciesMatch,
  splitIncludedVat,
} from "./quoteContracts.js";
import { catalogFactsProvenanceSchema } from "./catalogFactsProvenance.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import type { CommerceCurrency, CommerceMoney, CommerceQuote } from "./types.js";

// Build money in an arbitrary currency. The cast this helper used to need is gone:
// `CommerceCurrency` is now the widened alias from src/lib/currency/platformCurrency.ts,
// so the foreign-currency cases below are constructible directly. The *runtime*
// refusal they assert is unchanged — it lives in the schema, not in the type.
function money(amountMinor: number, currency: CommerceCurrency): CommerceMoney {
  return { amountMinor, currency };
}

function catalogFactsSettlement(quote: CommerceQuote) {
  return { currency: quote.currency };
}

function validPlnQuote(): CommerceQuote {
  return {
    currency: "PLN",
    taxIncluded: true,
    lines: [
      {
        sku: "OPENLUP-DOG-LAMB-CAN-400G",
        productSlug: "lamb",
        quantity: 1,
        unitPriceGross: money(1490, "PLN"),
        lineSubtotalGross: money(1490, "PLN"),
        tax: {
          included: true,
          country: "PL",
          category: "pet_food",
          vatRateBps: 800,
          legalBasis: "PL VAT Annex 3 item 10c",
          netAmount: money(1380, "PLN"),
          vatAmount: money(110, "PLN"),
          grossAmount: money(1490, "PLN"),
        },
      },
    ],
    discounts: [],
    subtotalGross: money(1490, "PLN"),
    discountTotalGross: money(0, "PLN"),
    totalGross: money(1490, "PLN"),
    netTotal: money(1380, "PLN"),
    taxTotal: money(110, "PLN"),
  };
}

describe("quote money currency backstop", () => {
  it("accepts a quote whose money all uses the quote currency", () => {
    expect(quoteMoneyCurrenciesMatch(validPlnQuote())).toBe(true);
    expect(commerceQuoteSchema.safeParse(validPlnQuote()).success).toBe(true);
  });

  it("rejects a line money in a foreign currency", () => {
    const quote = validPlnQuote();
    quote.lines[0].unitPriceGross = money(1490, "EUR");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("rejects a tax-breakdown money in a foreign currency", () => {
    const quote = validPlnQuote();
    quote.lines[0].tax.netAmount = money(1380, "EUR");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("rejects an order-total money in a foreign currency", () => {
    const quote = validPlnQuote();
    quote.taxTotal = money(110, "EUR");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("still accepts the wrapped quote response happy path", () => {
    const response = { contractVersion: COMMERCE_CONTRACT_VERSION, quote: validPlnQuote() };
    expect(createQuoteResponseSchema.safeParse(response).success).toBe(true);
  });

  it("accepts server-only v1 and policy-derived v2 facts with the required evidence", () => {
    const quote = validPlnQuote();
    const catalogFacts = {
      version: "catalog_facts_v1" as const,
      skuId: "11111111-1111-4111-8111-111111111111",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      documentDigest: "a".repeat(64),
      resolvedPriceEntryId: "resolved-entry",
      basePriceEntryId: "base-entry",
      mode: "one_time" as const,
      atTime: "2026-06-05T10:00:00.000Z",
      ...catalogFactsSettlement(quote),
      resolvedUnitAmountMinor: 1490,
      resolvedLineAmountMinor: 1490,
      baseUnitAmountMinor: 1490,
    };
    const response = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      quote: { ...quote, lines: [{ ...quote.lines[0]!, catalogFacts }] },
    };

    expect(catalogFactsProvenanceSchema.safeParse(catalogFacts).success).toBe(true);
    expect(createQuoteResponseSchema.safeParse(response).success).toBe(true);
    expect(catalogFactsProvenanceSchema.safeParse({
      ...catalogFacts,
      basePriceEntryId: null,
    }).success).toBe(false);

    const policyFacts = {
      version: "catalog_facts_v2" as const,
      skuId: "11111111-1111-4111-8111-111111111111",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      documentDigest: "a".repeat(64),
      basePriceEntryId: "base-entry",
      policyRevisionId: "33333333-3333-4333-8333-333333333333",
      policyDigest: "b".repeat(64),
      mode: "subscription" as const,
      atTime: "2026-06-05T10:00:00.000Z",
      ...catalogFactsSettlement(quote),
      resolvedUnitAmountMinor: 1340,
      resolvedLineAmountMinor: 1340,
      baseUnitAmountMinor: 1490,
    };
    const policyResponse = {
      contractVersion: COMMERCE_CONTRACT_VERSION,
      quote: { ...quote, lines: [{ ...quote.lines[0]!, catalogFacts: policyFacts }] },
    };

    expect(catalogFactsProvenanceSchema.safeParse(policyFacts).success).toBe(true);
    expect(createQuoteResponseSchema.safeParse(policyResponse).success).toBe(true);
    expect(publicCreateQuoteResponseSchema.safeParse(policyResponse).success).toBe(false);
    expect(catalogFactsProvenanceSchema.safeParse({ ...policyFacts, mode: "one_time" }).success).toBe(false);
    expect(catalogFactsProvenanceSchema.safeParse({ ...policyFacts, resolvedPriceEntryId: "authored-subscription-entry" }).success).toBe(false);
  });

  it("rejects server-only catalog facts from the public batch response", () => {
    const quote = validPlnQuote();
    const catalogFacts = catalogFactsProvenanceSchema.parse({
      version: "catalog_facts_v1", skuId: "11111111-1111-4111-8111-111111111111",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      documentDigest: "a".repeat(64), resolvedPriceEntryId: "resolved-entry",
      basePriceEntryId: "base-entry", mode: "one_time",
      atTime: "2026-06-05T10:00:00.000Z", currency: quote.currency,
      resolvedUnitAmountMinor: 1490, resolvedLineAmountMinor: 1490,
      baseUnitAmountMinor: 1490,
    });
    const response = { contractVersion: COMMERCE_CONTRACT_VERSION,
      quotes: [{ ...quote, lines: [{ ...quote.lines[0]!, catalogFacts }] }] };

    expect(publicCreateQuoteBatchResponseSchema.safeParse(response).success).toBe(false);
  });

  it("accepts a non-default tax rate as quote data", () => {
    const quote: CommerceQuote = {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "EXAMPLE-SKU-ALPHA",
          productSlug: "lamb",
          quantity: 1,
          unitPriceGross: money(12300, "PLN"),
          lineSubtotalGross: money(12300, "PLN"),
          tax: {
            included: true,
            country: "DE",
            category: "standard",
            vatRateBps: 2300,
            legalBasis: "Example VAT rule",
            netAmount: money(10000, "PLN"),
            vatAmount: money(2300, "PLN"),
            grossAmount: money(12300, "PLN"),
          },
        },
      ],
      discounts: [],
      subtotalGross: money(12300, "PLN"),
      discountTotalGross: money(0, "PLN"),
      totalGross: money(12300, "PLN"),
      netTotal: money(10000, "PLN"),
      taxTotal: money(2300, "PLN"),
    };

    expect(splitIncludedVat(12300, 2300)).toEqual({ netMinor: 10000, vatMinor: 2300 });
    expect(commerceQuoteSchema.safeParse(quote).success).toBe(true);
  });

  it("names mixed tax rates as unsupported for quote-level allocation", () => {
    const quote = validPlnQuote();
    quote.lines.push({
      sku: "EXAMPLE-SKU-ALPHA",
      productSlug: "lamb",
      quantity: 1,
      unitPriceGross: money(12300, "PLN"),
      lineSubtotalGross: money(12300, "PLN"),
      tax: {
        included: true,
        country: "DE",
        category: "standard",
        vatRateBps: 2300,
        legalBasis: "Example VAT rule",
        netAmount: money(10000, "PLN"),
        vatAmount: money(2300, "PLN"),
        grossAmount: money(12300, "PLN"),
      },
    });
    quote.subtotalGross = money(13790, "PLN");
    quote.totalGross = money(13790, "PLN");
    quote.netTotal = money(11380, "PLN");
    quote.taxTotal = money(2410, "PLN");

    const result = commerceQuoteSchema.safeParse(quote);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: "mixed VAT rates are not supported by quote discount and shipping tax allocation",
          path: ["lines"],
        }),
      ]));
    }
  });
});

describe("quote discount customer semantics", () => {
  const discount = {
    promotionId: "first-subscription",
    label: "Internal operator label",
    appliesTo: "order_total" as const,
    amountOffMinor: 8_330,
    reasonCode: "promotion_v2:target_percentage",
  };

  it("accepts the additive stable semantic", () => {
    expect(quoteDiscountSchema.safeParse({
      ...discount,
      customerSemantic: "first_subscription_50",
    }).success).toBe(true);
  });

  it("keeps historical discounts valid and rejects invented semantics", () => {
    expect(quoteDiscountSchema.safeParse(discount).success).toBe(true);
    expect(quoteDiscountSchema.safeParse({
      ...discount,
      customerSemantic: "operator_label_guess",
    }).success).toBe(false);
  });
});
