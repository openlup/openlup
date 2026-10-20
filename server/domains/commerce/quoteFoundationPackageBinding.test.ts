import { describe, expect, it } from "vitest";
import { createCommerceQuoteSchemas, createCommerceQuotePrimitives, CommerceQuoteError,
  CommerceQuoteCatalogReadError, quoteDiscountSchema as packageDiscount, catalogFactsProvenanceSchema as packageFacts,
  quoteCodeRejectionDetailSchema as packageDetail } from "@openlup/platform/pricing";
import { CommerceQuoteError as localError } from "../../../src/domains/commerce/ports.js";
import { CommerceQuoteCatalogReadError as localCatalogError } from "./commerceQuoteCatalogReadPort.js";
import { commerceCurrencySchema, commerceMoneySchema, commerceProductSlugSchema } from "../../../src/domains/commerce/contractPrimitives.js";
import { quoteContextSchema, commerceQuoteSchema, createQuoteRequestSchema, quoteDiscountSchema } from "../../../src/domains/commerce/quoteContracts.js";
import { catalogFactsProvenanceSchema } from "../../../src/domains/commerce/catalogFactsProvenance.js";
import { quoteCodeRejectionDetailSchema } from "../../../src/domains/commerce/quoteCodeRejectionDetails.js";

import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";

const CURRENCY = readSettlementProfile({}).defaultCurrency;
const bound = createCommerceQuoteSchemas({ currencySchema: commerceCurrencySchema,
  productSlugSchema: commerceProductSlugSchema, contextSchema: quoteContextSchema });
const outcome = (schema: { safeParse(value: unknown): unknown }, value: unknown) => JSON.parse(JSON.stringify(schema.safeParse(value)));

describe("quote foundation reference bindings", () => {
  it("preserves error identity and browser/server evidence and money refusals", () => {
    expect(localError).toBe(CommerceQuoteError);
    expect(localCatalogError).toBe(CommerceQuoteCatalogReadError);
    for (const [browser, server, values] of [
      [commerceMoneySchema, createCommerceQuotePrimitives(commerceCurrencySchema).commerceMoneySchema,
        [{ amountMinor: 1, currency: CURRENCY }, { amountMinor: 1, currency: "EUR" }, { amountMinor: -1, currency: CURRENCY }]],
      [quoteDiscountSchema, packageDiscount, [{ promotionId: "offer", appliesTo: "shipping", amountOffMinor: 1, reasonCode: "offer" }, { promotionEngineVersion: "promotion-engine.v2" }]],
      [catalogFactsProvenanceSchema, packageFacts, [{ version: "catalog_facts_v2", mode: "one_time" }]],
      [quoteCodeRejectionDetailSchema, packageDetail, [{ code: "CODE", reason: "minimum_not_met", minimumReferenceMinor: 12 }, { code: "CODE", reason: "minimum_not_met", minimumReferenceMinor: -1 }]],
    ] as const) for (const value of values) expect(outcome(browser, value)).toEqual(outcome(server, value));
  });

  it("keeps rich context validation local while sharing unchanged quote equations", () => {
    const request = { mode: "subscription", lines: [{ sku: "SKU", quantity: 1 }], promoCodes: [],
      cadenceDays: 14, petProfileContext: { petId: "profile", dailyKcalOverride: 100 },
      sizeConstraint: { kind: "feeding_days", value: 14, dailyKcalOverride: 100 } };
    expect(createQuoteRequestSchema.safeParse(request).success).toBe(true);
    expect(createQuoteRequestSchema.safeParse({ ...request, cadenceDays: null }).success).toBe(false);
    expect(createQuoteRequestSchema.safeParse({ ...request, sizeConstraint: { kind: "feeding_days", value: 14 } }).success).toBe(false);
    const money = (amountMinor: number) => ({ amountMinor, currency: CURRENCY });
    const quote = { currency: CURRENCY, taxIncluded: true, context: { mode: "subscription", promoCodes: [], petProfileContext: request.petProfileContext },
      lines: [{ sku: "SKU", productSlug: "item", quantity: 1, unitPriceGross: money(108), lineSubtotalGross: money(108),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 800, legalBasis: "Example", netAmount: money(100), vatAmount: money(8), grossAmount: money(108) } }],
      discounts: [], subtotalGross: money(108), discountTotalGross: money(0), totalGross: money(108), netTotal: money(100), taxTotal: money(8) };
    for (const value of [quote, { ...quote, totalGross: money(109) }, { ...quote, context: { ...quote.context, unknown: true } }]) {
      expect(outcome(commerceQuoteSchema, value)).toEqual(outcome(bound.commerceQuoteSchema, value));
    }
  });
});
