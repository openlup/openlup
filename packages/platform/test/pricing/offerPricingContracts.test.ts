import "./neutralFixtures.js";
import { describe, expect, it } from "vitest";

import {
  commerceOfferPricingResponseSchema,
  COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
  COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
} from "./quoteSchemaFixtures.js";

const price = {
  productSlug: "item-alpha", unitCount: 14,
  oneTime: { packageGross: { amountMinor: 1400, currency: "XXX" }, unitGross: { amountMinor: 100, currency: "XXX" } },
  subscriptionInitial: { packageGross: { amountMinor: 700, currency: "XXX" }, unitGross: { amountMinor: 50, currency: "XXX" } },
  subscriptionRecurring: { packageGross: { amountMinor: 1260, currency: "XXX" }, unitGross: { amountMinor: 90, currency: "XXX" } },
  catalogAnchorUnitGross: { amountMinor: 100, currency: "XXX" },
  initialDiscountPercent: 50, recurringDiscountPercent: 10,
} as const;

const validV2Response = {
  contractVersion: COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
  scope: "example_products_and_shipping",
  pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
  products: [price], minimum: { oneTime: price, subscription: price },
  shipping: {
    gross: { amountMinor: 1500, currency: "XXX" },
    discountGross: { amountMinor: 1500, currency: "XXX" },
    payable: { amountMinor: 0, currency: "XXX" },
  },
  minimumProductPayable: { amountMinor: 100, currency: "XXX" },
} as const;

describe("offer pricing contracts", () => {
  it("preserves the exact v1 product-only shape", () => {
    expect(commerceOfferPricingResponseSchema.parse({
      contractVersion: COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
      scope: "example_products_only_excludes_shipping", products: [price],
      minimum: { oneTime: price, subscription: price },
    }).contractVersion).toBe(COMMERCE_OFFER_PRICING_CONTRACT_VERSION);
  });

  it("requires policy identity, shipping and the 1 XXX floor in v2", () => {
    expect(commerceOfferPricingResponseSchema.parse(validV2Response).contractVersion)
      .toBe(COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION);
  });

  it.each([
    ["a v1 policy pair", {
      ...validV2Response,
      pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v1", promotionEngineVersion: "promotion-engine.v1" },
    }],
    ["a product floor other than 1 XXX", {
      ...validV2Response,
      minimumProductPayable: { amountMinor: 99, currency: "XXX" },
    }],
    ["inconsistent shipping arithmetic", {
      ...validV2Response,
      shipping: { ...validV2Response.shipping, payable: { amountMinor: 1, currency: "XXX" } },
    }],
  ])("rejects v2 with %s", (_case, response) => {
    expect(commerceOfferPricingResponseSchema.safeParse(response).success).toBe(false);
  });
});
