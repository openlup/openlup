import { describe, expect, it } from "vitest";

import type { CommerceQuote } from "../../../src/domains/commerce/types.js";
import {
  PROMOTION_QUOTE_MISMATCH_FIELDS,
  PROMOTION_QUOTE_MONEY_SECTIONS,
  projectPromotionQuoteMoney,
  promotionQuoteMoneySections,
  stableJson,
} from "./promotionQuoteBinding.js";

/**
 * `XTS` is the ISO 4217 code reserved for testing, which this repo uses so a
 * fixture basket carries no nationality: real currency codes are counted
 * vocabulary in the OSS neutrality ratchet.
 */
const money = (amountMinor: number) => ({ amountMinor, currency: "XTS" });

/** A line carrying every presentation and server-only field the projection must drop. */
const LINE = {
  sku: "SKU-ALPHA-400G",
  productSlug: "slug-alpha",
  quantity: 2,
  unitPriceGross: money(4_900),
  lineSubtotalGross: money(9_800),
  tax: {
    included: true as const, country: "XT", category: "standard",
    vatRateBps: 2_300, legalBasis: "fixture-basis",
    netAmount: money(7_970), vatAmount: money(1_830), grossAmount: money(9_800),
  },
  pricingComponents: [{
    scope: "line" as const, componentType: "base_unit" as const,
    amountMinor: 4_900, reasonCode: "base_unit_price", reasonPayload: {},
  }],
  catalogFacts: {
    version: "catalog_facts_v1", skuId: "55555555-5555-4555-8555-555555555555",
    documentDigest: "b".repeat(64), atTime: "2026-07-14T10:00:00.000Z",
  },
};

/** A discount carrying every unbound identity and presentation field beside the bound ones. */
const DISCOUNT_FIRST = {
  promotionId: "33333333-3333-4333-8333-333333333333",
  appliesTo: "order_total" as const,
  amountOffMinor: 1_300,
  promotionCodeId: "44444444-4444-4444-8444-444444444444",
  promotionDefinitionFingerprint: "a".repeat(64),
  promotionBenefitKind: "target_percentage" as const,
  promotionBenefitValueBps: 1_000,
  promotionBenefitValueMinor: 1_300,
  label: "Offer label", reasonCode: "promotion_code_v2",
  customerSemantic: "first_purchase_10" as const, code: "SAVE10",
  promotionCodeRevision: 3, promotionCodeScopes: ["one_time" as const],
  promotionMinimumReferenceMinor: 0, promotionCodeValidTo: "2026-07-20T00:00:00.000Z",
  floorApplied: false,
};

/** The second lane: it proves emission order survives the projection. */
const DISCOUNT_SECOND = {
  promotionId: "66666666-6666-4666-8666-666666666666",
  appliesTo: "shipping" as const,
  amountOffMinor: 500,
  reasonCode: "free_shipping",
};

const QUOTE: CommerceQuote = {
  currency: "XTS",
  taxIncluded: true,
  lines: [LINE],
  discounts: [DISCOUNT_FIRST, DISCOUNT_SECOND],
  pricingComponents: [{
    scope: "order", componentType: "promo", amountMinor: -1_300,
    reasonCode: "promotion_code_v2", reasonPayload: {},
  }],
  context: { mode: "one_time", promoCodes: ["SAVE10"] },
  codeRejections: [{ code: "OTHER10", reason: "not_recognized" }],
  codeRejectionDetails: [{ code: "OTHER10", reason: "global_limit_reached" }],
  subtotalGross: money(9_800),
  discountTotalGross: money(1_800),
  shippingGross: money(1_500),
  shippingDiscountGross: money(500),
  totalGross: money(9_000),
  netTotal: money(7_317),
  taxTotal: money(1_683),
};

const EXPECTED_LINE = {
  sku: "SKU-ALPHA-400G",
  quantity: 2,
  unitPriceGross: money(4_900),
  lineSubtotalGross: money(9_800),
  tax: {
    vatRateBps: 2_300, netAmount: money(7_970),
    vatAmount: money(1_830), grossAmount: money(9_800),
  },
};

const EXPECTED_TOTALS = {
  totalGross: money(9_000), netTotal: money(7_317), taxTotal: money(1_683),
  subtotalGross: money(9_800), discountTotalGross: money(1_800),
};

const EXPECTED_DISCOUNTS = [
  {
    promotionId: DISCOUNT_FIRST.promotionId, appliesTo: "order_total", amountOffMinor: 1_300,
    promotionCodeId: DISCOUNT_FIRST.promotionCodeId,
    promotionDefinitionFingerprint: "a".repeat(64),
    promotionBenefitKind: "target_percentage",
    promotionBenefitValueBps: 1_000, promotionBenefitValueMinor: 1_300,
  },
  {
    promotionId: DISCOUNT_SECOND.promotionId, appliesTo: "shipping", amountOffMinor: 500,
    promotionCodeId: null, promotionDefinitionFingerprint: null, promotionBenefitKind: null,
    promotionBenefitValueBps: null, promotionBenefitValueMinor: null,
  },
];

const EXPECTED_PROJECTION = {
  currency: "XTS",
  ...EXPECTED_TOTALS,
  shippingGross: money(1_500),
  shippingDiscountGross: money(500),
  lines: [EXPECTED_LINE],
  discounts: EXPECTED_DISCOUNTS,
};

describe("promotion quote money projection", () => {
  it("keeps the documented money fields and drops presentation and server-only evidence", () => {
    expect(projectPromotionQuoteMoney(QUOTE)).toStrictEqual(EXPECTED_PROJECTION);
  });

  it("reads absent shipping and absent optional discount fields as null", () => {
    const projection = projectPromotionQuoteMoney({
      ...QUOTE, shippingGross: undefined, shippingDiscountGross: undefined,
      discounts: [DISCOUNT_SECOND],
    });

    expect(projection.shippingGross).toBeNull();
    expect(projection.shippingDiscountGross).toBeNull();
    expect(projection.discounts).toStrictEqual([EXPECTED_DISCOUNTS[1]]);
  });

  it("preserves discount emission order", () => {
    const ids = (quote: CommerceQuote) =>
      projectPromotionQuoteMoney(quote).discounts.map((discount) => discount.promotionId);

    expect(ids(QUOTE)).toEqual([DISCOUNT_FIRST.promotionId, DISCOUNT_SECOND.promotionId]);
    expect(ids({ ...QUOTE, discounts: [DISCOUNT_SECOND, DISCOUNT_FIRST] }))
      .toEqual([DISCOUNT_SECOND.promotionId, DISCOUNT_FIRST.promotionId]);
  });
});

describe("promotion quote money sections", () => {
  it("partitions the projection into five sections whose union is the projection", () => {
    const sections = promotionQuoteMoneySections(QUOTE);

    expect(Object.keys(sections)).toEqual([...PROMOTION_QUOTE_MONEY_SECTIONS]);
    expect(sections.lines).toStrictEqual([EXPECTED_LINE]);
    expect(sections.discounts).toStrictEqual(EXPECTED_DISCOUNTS);
    expect(sections.shipping).toStrictEqual({
      shippingGross: money(1_500), shippingDiscountGross: money(500),
    });
    expect(sections.totals).toStrictEqual(EXPECTED_TOTALS);
    expect(sections.currency).toBe("XTS");
    expect({
      ...(sections.totals as Record<string, unknown>),
      ...(sections.shipping as Record<string, unknown>),
      currency: sections.currency, lines: sections.lines, discounts: sections.discounts,
    }).toStrictEqual(EXPECTED_PROJECTION);
  });

  it("names one mismatch field per section plus the honest fallback", () => {
    expect(PROMOTION_QUOTE_MISMATCH_FIELDS).toEqual([...PROMOTION_QUOTE_MONEY_SECTIONS, "other"]);
  });
});

describe("stableJson", () => {
  it("sorts object keys", () => {
    expect(stableJson({ currency: "XTS", amountMinor: 900 })).toBe('{"amountMinor":900,"currency":"XTS"}');
  });

  it("drops undefined values and keeps null", () => {
    expect(stableJson({ shippingGross: undefined, shippingDiscountGross: null })).toBe('{"shippingDiscountGross":null}');
  });

  it("serialises arrays in order", () => {
    expect(stableJson([{ b: 2, a: 1 }, "second", 3])).toBe('[{"a":1,"b":2},"second",3]');
  });
});
