import { describe, expect, it } from "vitest";

import {
  commerceOfferPricingResponseSchema,
  COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
  COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
} from "./offerPricingContracts.js";

const price = {
  productSlug: "lamb", unitCount: 14,
  oneTime: { packageGross: { amountMinor: 1400, currency: "PLN" }, unitGross: { amountMinor: 100, currency: "PLN" } },
  subscriptionInitial: { packageGross: { amountMinor: 700, currency: "PLN" }, unitGross: { amountMinor: 50, currency: "PLN" } },
  subscriptionRecurring: { packageGross: { amountMinor: 1260, currency: "PLN" }, unitGross: { amountMinor: 90, currency: "PLN" } },
  catalogAnchorUnitGross: { amountMinor: 100, currency: "PLN" },
  initialDiscountPercent: 50, recurringDiscountPercent: 10,
} as const;

const validV2Response = {
  contractVersion: COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
  scope: "dog_products_and_shipping",
  pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
  products: [price], minimum: { oneTime: price, subscription: price },
  shipping: {
    gross: { amountMinor: 1500, currency: "PLN" },
    discountGross: { amountMinor: 1500, currency: "PLN" },
    payable: { amountMinor: 0, currency: "PLN" },
  },
  minimumProductPayable: { amountMinor: 100, currency: "PLN" },
} as const;

describe("offer pricing contracts", () => {
  it("preserves the exact v1 product-only shape", () => {
    expect(commerceOfferPricingResponseSchema.parse({
      contractVersion: COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
      scope: "dog_products_only_excludes_shipping", products: [price],
      minimum: { oneTime: price, subscription: price },
    }).contractVersion).toBe(COMMERCE_OFFER_PRICING_CONTRACT_VERSION);
  });

  it("requires policy identity, shipping and the 1 PLN floor in v2", () => {
    expect(commerceOfferPricingResponseSchema.parse(validV2Response).contractVersion)
      .toBe(COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION);
  });

  it.each([
    ["a v1 policy pair", {
      ...validV2Response,
      pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" },
    }],
    ["a product floor other than 1 PLN", {
      ...validV2Response,
      minimumProductPayable: { amountMinor: 99, currency: "PLN" },
    }],
    ["inconsistent shipping arithmetic", {
      ...validV2Response,
      shipping: { ...validV2Response.shipping, payable: { amountMinor: 1, currency: "PLN" } },
    }],
  ])("rejects v2 with %s", (_case, response) => {
    expect(commerceOfferPricingResponseSchema.safeParse(response).success).toBe(false);
  });
});
