import { describe, expect, it, vi } from "vitest";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/index.js";
import {
  commerceQuoteV2Schema,
  createCommerceQuoteSchemas,
  quoteDiscountSchema,
  quoteMoneyCurrenciesMatch,
  splitIncludedVat,
} from "../../src/pricing/index.js";
import { catalogFactsProvenanceSchema } from "../../src/pricing/index.js";
import { COMMERCE_CONTRACT_VERSION } from "../../src/pricing/contracts/index.js";
import type { CommerceCurrency, CommerceMoney, CommerceQuote } from "../../src/pricing/contracts/index.js";

import type { CommerceQuoteMoneyV2, CommerceQuoteV2 } from "../../src/pricing/index.js";
import { id, moneyGolden, sealQuote } from "./quoteMoneyV2Fixtures.js";

import { z } from "zod";
import { slugSchema } from "@openlup/core/catalog";

vi.mock("../../src/catalog/contracts/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/catalog/contracts/index.js")>();
  return { ...original, canonicalCatalogDraftJson: vi.fn(original.canonicalCatalogDraftJson) };
});

const { commerceQuoteSchema, createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteBatchResponseSchema,
  publicCreateQuoteResponseSchema } = createCommerceQuoteSchemas({
  currencySchema: z.string().regex(/^[A-Z]{3}$/).refine(code => code === "XXX", { message: "currency_not_settlement_currency" }),
  productSlugSchema: slugSchema,
  contextSchema: z.object({ mode: z.enum(["one_time", "subscription"]), promoCodes: z.array(z.string()) }),
});

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

function validQuote(): CommerceQuote {
  return {
    currency: "XXX",
    taxIncluded: true,
    lines: [
      {
        sku: "ITEM-ALPHA-400",
        productSlug: "item-alpha",
        quantity: 1,
        unitPriceGross: money(1490, "XXX"),
        lineSubtotalGross: money(1490, "XXX"),
        tax: {
          included: true,
          country: "ZZ",
          category: "example_category",
          vatRateBps: 800,
          legalBasis: "Example VAT rule",
          netAmount: money(1380, "XXX"),
          vatAmount: money(110, "XXX"),
          grossAmount: money(1490, "XXX"),
        },
      },
    ],
    discounts: [],
    subtotalGross: money(1490, "XXX"),
    discountTotalGross: money(0, "XXX"),
    totalGross: money(1490, "XXX"),
    netTotal: money(1380, "XXX"),
    taxTotal: money(110, "XXX"),
  };
}

describe("quote request collection bounds", () => {
  it.each(["lines", "promoCodes"] as const)("rejects oversized invalid %s before collecting element errors", (field) => {
    const result = createQuoteRequestSchema.safeParse({
      lines: [{ sku: "ITEM-ALPHA-400", quantity: 1 }],
      [field]: Array.from({ length: 200 }, () => null),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toMatchObject([{ code: "too_big", path: [field] }]);
      expect(result.error.issues).toHaveLength(1);
    }
  });

  it("preserves bounded input normalization and request defaults", () => {
    expect(createQuoteRequestSchema.parse({
      lines: [{ sku: " ITEM-ALPHA-400 ", quantity: 1 }],
    })).toEqual({ mode: "one_time", lines: [{ sku: "ITEM-ALPHA-400", quantity: 1 }], promoCodes: [] });
  });
});

describe("quote money currency backstop", () => {
  it("accepts a quote whose money all uses the quote currency", () => {
    expect(quoteMoneyCurrenciesMatch(validQuote())).toBe(true);
    expect(commerceQuoteSchema.safeParse(validQuote()).success).toBe(true);
  });

  it("rejects a line money in a foreign currency", () => {
    const quote = validQuote();
    quote.lines[0].unitPriceGross = money(1490, "XTS");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("rejects a tax-breakdown money in a foreign currency", () => {
    const quote = validQuote();
    quote.lines[0].tax.netAmount = money(1380, "XTS");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("rejects an order-total money in a foreign currency", () => {
    const quote = validQuote();
    quote.taxTotal = money(110, "XTS");
    expect(quoteMoneyCurrenciesMatch(quote)).toBe(false);
  });

  it("still accepts the wrapped quote response happy path", () => {
    const response = { contractVersion: COMMERCE_CONTRACT_VERSION, quote: validQuote() };
    expect(createQuoteResponseSchema.safeParse(response).success).toBe(true);
  });

  it("accepts server-only v1 and policy-derived v2 facts with the required evidence", () => {
    const quote = validQuote();
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
    const quote = validQuote();
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
      currency: "XXX",
      taxIncluded: true,
      lines: [
        {
          sku: "EXAMPLE-SKU-ALPHA",
          productSlug: "item-alpha",
          quantity: 1,
          unitPriceGross: money(12300, "XXX"),
          lineSubtotalGross: money(12300, "XXX"),
          tax: {
            included: true,
            country: "QZ",
            category: "standard",
            vatRateBps: 2300,
            legalBasis: "Example VAT rule",
            netAmount: money(10000, "XXX"),
            vatAmount: money(2300, "XXX"),
            grossAmount: money(12300, "XXX"),
          },
        },
      ],
      discounts: [],
      subtotalGross: money(12300, "XXX"),
      discountTotalGross: money(0, "XXX"),
      totalGross: money(12300, "XXX"),
      netTotal: money(10000, "XXX"),
      taxTotal: money(2300, "XXX"),
    };

    expect(splitIncludedVat(12300, 2300)).toEqual({ netMinor: 10000, vatMinor: 2300 });
    expect(commerceQuoteSchema.safeParse(quote).success).toBe(true);
  });

  it("names mixed tax rates as unsupported for quote-level allocation", () => {
    const quote = validQuote();
    quote.lines.push({
      sku: "EXAMPLE-SKU-ALPHA",
      productSlug: "item-alpha",
      quantity: 1,
      unitPriceGross: money(12300, "XXX"),
      lineSubtotalGross: money(12300, "XXX"),
      tax: {
        included: true,
        country: "QZ",
        category: "standard",
        vatRateBps: 2300,
        legalBasis: "Example VAT rule",
        netAmount: money(10000, "XXX"),
        vatAmount: money(2300, "XXX"),
        grossAmount: money(12300, "XXX"),
      },
    });
    quote.subtotalGross = money(13790, "XXX");
    quote.totalGross = money(13790, "XXX");
    quote.netTotal = money(11380, "XXX");
    quote.taxTotal = money(2410, "XXX");

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

it("preserves both shipping and discount tax lanes and their currency backstop", () => {
  const quote: CommerceQuote = {
    ...validQuote(),
    discounts: [
      { promotionId: "order", appliesTo: "order_total", amountOffMinor: 108, reasonCode: "order" },
      { promotionId: "shipping", appliesTo: "shipping", amountOffMinor: 54, reasonCode: "shipping" },
    ],
    discountTotalGross: money(108, "XXX"), shippingGross: money(108, "XXX"),
    shippingDiscountGross: money(54, "XXX"), totalGross: money(1436, "XXX"),
    netTotal: money(1330, "XXX"), taxTotal: money(106, "XXX"),
  };
  expect(commerceQuoteSchema.safeParse(quote).success).toBe(true);
  expect(commerceQuoteSchema.safeParse({ ...quote, shippingDiscountGross: money(55, "XXX") }).success).toBe(false);
  expect(quoteMoneyCurrenciesMatch({ ...quote, shippingGross: money(108, "XTS") })).toBe(false);
  expect(quoteMoneyCurrenciesMatch({ ...quote, shippingDiscountGross: money(54, "XTS") })).toBe(false);
});

describe("strict quote v2", () => {
  function refusal(value: unknown) {
    const result = commerceQuoteV2Schema.safeParse(value);
    if (result.success) throw new Error("Expected a quote refusal");
    return result.error.issues[0];
  }

  it.each(["final", "estimate"] as const)("validates the sealed %s quote", status => {
    const quote = sealQuote(moneyGolden(), status);
    expect(commerceQuoteV2Schema.parse(quote)).toStrictEqual(quote);
  });

  it("preserves the original v0 quote serialization through the v0 schema", () => {
    const legacy = { contractVersion: COMMERCE_CONTRACT_VERSION, quote: validQuote() };
    expect(JSON.stringify(createQuoteResponseSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  });

  it("requires both original digests before amount or expiry advice", () => {
    const original = sealQuote();
    const [first, ...rest] = original.lines;
    const [share] = first.discountAllocations;
    const { payableMinor: _payable, ...withoutPayable } = original;
    const { expiresAt: _expiry, ...withoutExpiry } = original.taxEvidence;
    const altered = [
      { ...original, lines: [{ ...first, discountAllocations: [{ ...share, allocationId: id(6) }] }, ...rest] },
      { ...original, destination: { ...original.destination, snapshotRef: id(7) } },
      { ...original, status: "estimate" },
      withoutPayable,
      { ...original, taxEvidence: withoutExpiry },
      { ...original, paymentLimits: { ...original.paymentLimits, maxMinor: original.payableMinor - 1 },
        taxEvidence: { ...original.taxEvidence, expiresAt: original.taxEvidence.taxDate } },
    ];
    altered.forEach((quote, index) => {
      if ("payableMinor" in quote) expect(quote.payableMinor).toBe(original.payableMinor);
      expect(refusal(quote)).toMatchObject({ params: {
        code: "money_tax_evidence_mismatch", field: index === 2 ? "/quoteDigest" : "/moneyDigest",
        remedy: "Replay the original document and its digest.",
      } });
      expect(JSON.stringify(refusal(quote))).not.toContain(original.quoteDigest);
    });
  });

  it("encodes each digest preimage once without encoding the whole quote first", () => {
    const quote = sealQuote();
    const encode = vi.mocked(canonicalCatalogDraftJson);
    encode.mockClear();
    expect(commerceQuoteV2Schema.safeParse(quote).success).toBe(true);
    expect(encode.mock.calls.map(([preimage]) => (preimage as readonly unknown[])[0])).toEqual([
      "commerce.quote-money.v2", "commerce.quote.v2",
    ]);
  });

  it.each([
    ["unknown nested key", (body: CommerceQuoteMoneyV2) => ({ ...body, destination: { ...body.destination, extra: "value" } })],
    ["UUID casing", (body: CommerceQuoteMoneyV2) => ({ ...body, destination: { ...body.destination, snapshotRef: "A" + id(1).slice(1) } })],
    ["digest width", (body: CommerceQuoteMoneyV2) => ({ ...body, coverageDigest: "a".repeat(63) })],
    ["canonical instant", (body: CommerceQuoteMoneyV2) => ({ ...body, taxEvidence: { ...body.taxEvidence, taxDate: "2026-06-05T10:00:00Z" } })],
    ["source count", (body: CommerceQuoteMoneyV2) => ({ ...body, lines: Array.from({ length: 51 }, () => body.lines[0]) })],
    ["quantity upper bound", (body: CommerceQuoteMoneyV2) =>
      ({ ...body, lines: [{ ...body.lines[0], quantity: 100 }, ...body.lines.slice(1)] })],
    ["fractional amount", (body: CommerceQuoteMoneyV2) => ({ ...body, payableMinor: 5.5 })],
    ["unsafe amount", (body: CommerceQuoteMoneyV2) => ({ ...body, payableMinor: Number.MAX_SAFE_INTEGER + 1 })],
    ["wrong total", (body: CommerceQuoteMoneyV2) => ({ ...body, taxTotal: 1 })],
    ["currency mismatch", (body: CommerceQuoteMoneyV2) => ({ ...body, paymentLimits: { ...body.paymentLimits, currency: "ZZZ" } })],
    ["subscription without cadence", (body: CommerceQuoteMoneyV2) => ({ ...body, mode: "subscription" as const })],
    ["one-time quote with cadence", (body: CommerceQuoteMoneyV2) => ({ ...body, cadence: { schemaVersion: 1 as const, kind: "fixed_days" as const, days: 17 } })],
    ["wrong evidence arm", (body: CommerceQuoteMoneyV2) => ({ ...body, taxEvidence: { ...body.taxEvidence, kind: "tax_calculation" as const } })],
    ["unreconciled tax state", (body: CommerceQuoteMoneyV2) => {
      const [first, ...rest] = body.lines;
      const [share] = first.discountAllocations;
      const before = { ...share.before, taxPositions: [{ ...share.before.taxPositions[0], taxMinor: 0 }] };
      return { ...body, lines: [{ ...first, discountAllocations: [{ ...share, before }] }, ...rest] };
    }],
  ] as const)("rejects %s even with matching digests", (_name, change) => {
    expect(commerceQuoteV2Schema.safeParse(sealQuote(change(moneyGolden()) as CommerceQuoteMoneyV2)).success).toBe(false);
  });

  it("refuses lossy numbers and bounds the admitted quote size", () => {
    const quote = sealQuote();
    expect(refusal({ ...quote, feeTotal: -0 }).params).toMatchObject({ field: "/feeTotal" });
    expect(refusal({ ...quote, catalogueEvidenceRef: "λ".repeat(1_048_577) }).params).toMatchObject({ field: "/catalogueEvidenceRef" });
  });

  it("admits independent line modes and checks range on an intact document", () => {
    const body = moneyGolden();
    const subscription = { ...body, mode: "subscription", cadence: { schemaVersion: 1, kind: "fixed_days", days: 3660 } } as const;
    expect(commerceQuoteV2Schema.parse(sealQuote(subscription)).lines[0].mode).toBe("one_time");
    expect(refusal(sealQuote({ ...body, paymentLimits: { ...body.paymentLimits, maxMinor: 4 } }))).toMatchObject({
      params: { code: "money_amount_out_of_range", field: "/payableMinor" },
    });
  });
});
