import { describe, expect, it } from "vitest";

import {
  quoteEffectiveDiscountPercent,
  quoteModeDiscountPercent,
  type CommerceQuote,
} from "./useLiveQuote";

/**
 * Effective-discount helper coverage, split into a sibling file to keep each
 * test module under the 300-line architecture guardrail. Sibling of
 * `useLiveQuote.test.ts` (which covers the hook, request builder, and band-only
 * helpers).
 */
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function quote(over: DeepPartial<CommerceQuote> = {}): CommerceQuote {
  return {
    discounts: [],
    totalGross: { currency: "PLN", amountMinor: 1000 },
    pricingComponents: [
      { scope: "line", componentType: "base_unit", amountMinor: 1200, reasonCode: "base" },
    ],
    lines: [],
    ...over,
  } as unknown as CommerceQuote;
}

describe("effective discount helpers", () => {
  // Real live-quote shape (verified on hidden-preview): the band is a
  // `mode_discount` pricing component, but promos/codes are carried ONLY in
  // `discounts[]` — the BFF emits no `promo` pricing component. base 56620,
  // band −5700, first-subscription promo 22610 (off) → effective 50%.
  const bandPlusPromo = quote({
    pricingComponents: [
      { scope: "order", componentType: "base_unit", amountMinor: 56620, reasonCode: "base" },
      { scope: "order", componentType: "mode_discount", amountMinor: -5700, reasonCode: "subscription_band" },
    ],
    discounts: [
      { promotionId: "p1", reasonCode: "promo:first_subscription_50", amountOffMinor: 22610 },
    ],
    totalGross: { currency: "PLN", amountMinor: 28310 },
  });

  it("folds band + discounts[] promo into the effective percent, band alone into recurring (regression: promo lives in discounts[], not a component)", () => {
    expect(quoteModeDiscountPercent(bandPlusPromo)).toBe(10); // recurring band only
    expect(quoteEffectiveDiscountPercent(bandPlusPromo)).toBe(50); // (5700 + 22610)/56620
  });

  it("equals the band percent when there is no promo", () => {
    const bandOnly = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 20860, reasonCode: "base" },
        { scope: "order", componentType: "mode_discount", amountMinor: -2100, reasonCode: "subscription_band" },
      ],
      totalGross: { currency: "PLN", amountMinor: 18760 },
    });
    expect(quoteEffectiveDiscountPercent(bandOnly)).toBe(10);
    expect(quoteModeDiscountPercent(bandOnly)).toBe(10);
  });

  it("reports a promo-only effective percent with no recurring band", () => {
    const promoOnly = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 1000, reasonCode: "base" },
      ],
      discounts: [{ promotionId: "p2", reasonCode: "promo_code", amountOffMinor: 200 }],
      totalGross: { currency: "PLN", amountMinor: 800 },
    });
    expect(quoteModeDiscountPercent(promoOnly)).toBeNull();
    expect(quoteEffectiveDiscountPercent(promoOnly)).toBe(20);
  });

  it("sums multiple discounts[] entries on top of the band", () => {
    const stacked = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 1000, reasonCode: "base" },
        { scope: "order", componentType: "mode_discount", amountMinor: -100, reasonCode: "subscription_band" },
      ],
      discounts: [
        { promotionId: "a", reasonCode: "promo_a", amountOffMinor: 150 },
        { promotionId: "b", reasonCode: "promo_b", amountOffMinor: 50 },
      ],
      totalGross: { currency: "PLN", amountMinor: 700 },
    });
    // (100 + 150 + 50) / 1000 = 30%
    expect(quoteEffectiveDiscountPercent(stacked)).toBe(30);
  });

  it("ignores shipping — derived from discounts, never from totalGross", () => {
    // base 1000, band −100, promo 100 off, +50 shipping baked into totalGross 850.
    // effective = (100 + 100)/1000 = 20%, shipping in the total does not distort it.
    const withShipping = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 1000, reasonCode: "base" },
        { scope: "order", componentType: "mode_discount", amountMinor: -100, reasonCode: "subscription_band" },
        { scope: "order", componentType: "shipping", amountMinor: 50, reasonCode: "shipping" },
      ],
      discounts: [{ promotionId: "p3", reasonCode: "promo_code", amountOffMinor: 100 }],
      totalGross: { currency: "PLN", amountMinor: 850 },
    });
    expect(quoteEffectiveDiscountPercent(withShipping)).toBe(20);
  });

  it("excludes a free-shipping discount from the product-discount percent (regression: the fictional −62%)", () => {
    // Real small-dog subscription shape: base 20860, band −2100, first-subscription
    // promo 8330 off (product), plus a free-shipping discount of 1500 carried in
    // discounts[] with appliesTo "shipping". Folding the 1500 in would inflate
    // the honest 50% product discount.
    const withFreeShipping = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 20860, reasonCode: "base" },
        { scope: "order", componentType: "mode_discount", amountMinor: -2100, reasonCode: "subscription_band" },
      ],
      discounts: [
        { promotionId: "p-sub", reasonCode: "promo:first_subscription_50", appliesTo: "order_total", amountOffMinor: 8330 },
        { promotionId: "p-ship", reasonCode: "promo:subscription_free_shipping", appliesTo: "shipping", amountOffMinor: 1500 },
      ],
      totalGross: { currency: "PLN", amountMinor: 10430 },
    });
    expect(quoteEffectiveDiscountPercent(withFreeShipping)).toBe(50);
  });

  it("returns null when nothing is discounted", () => {
    const none = quote({
      pricingComponents: [
        { scope: "order", componentType: "base_unit", amountMinor: 1000, reasonCode: "base" },
      ],
      totalGross: { currency: "PLN", amountMinor: 1000 },
    });
    expect(quoteEffectiveDiscountPercent(none)).toBeNull();
  });
});
