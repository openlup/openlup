import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../../_lib/types/vercel.js";

import {
  COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
  COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
  type CommerceOfferPricingResponse,
} from "../../../src/domains/commerce/offerPricingContracts.js";
import {
  COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL,
  COMMERCE_OFFER_PRICING_CACHE_CONTROL,
  createCommerceOfferPricingHandler,
} from "./commerceOfferPricingHandler.js";

const price = {
  productSlug: "lamb",
  unitCount: 14,
  oneTime: {
    packageGross: { amountMinor: 20_860, currency: "PLN" },
    unitGross: { amountMinor: 1490, currency: "PLN" },
  },
  subscriptionInitial: {
    packageGross: { amountMinor: 10_430, currency: "PLN" },
    unitGross: { amountMinor: 745, currency: "PLN" },
  },
  subscriptionRecurring: {
    packageGross: { amountMinor: 18_760, currency: "PLN" },
    unitGross: { amountMinor: 1340, currency: "PLN" },
  },
  catalogAnchorUnitGross: { amountMinor: 1490, currency: "PLN" },
  initialDiscountPercent: 50,
  recurringDiscountPercent: 10,
} as const;

const payload = {
  contractVersion: COMMERCE_OFFER_PRICING_CONTRACT_VERSION,
  scope: "dog_products_only_excludes_shipping",
  products: [price],
  minimum: { oneTime: price, subscription: price },
} as CommerceOfferPricingResponse;

describe("commerce offer pricing handler", () => {
  it("returns the strict product-only projection", async () => {
    const res = createResponse();
    await createCommerceOfferPricingHandler({
      readOfferPricing: async () => payload,
    })({ method: "GET" } as never, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      COMMERCE_OFFER_PRICING_CACHE_CONTROL,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({ scope: "dog_products_only_excludes_shipping" }),
    }));
  });

  it("keeps a no-capability request on the literal v1 read path", async () => {
    const res = createResponse();
    const readOfferPricing = vi.fn(async () => payload);
    const resolvePricingPolicy = vi.fn();
    await createCommerceOfferPricingHandler({ readOfferPricing, resolvePricingPolicy })(
      { method: "GET", headers: {} } as never,
      res,
    );

    expect(resolvePricingPolicy).not.toHaveBeenCalled();
    expect(readOfferPricing).toHaveBeenCalledWith(undefined);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", COMMERCE_OFFER_PRICING_CACHE_CONTROL);
  });

  it("rejects the unassigned v1 read path when v1 fallback is disabled", async () => {
    const res = createResponse();
    const readOfferPricing = vi.fn(async () => payload);
    await createCommerceOfferPricingHandler({
      readOfferPricing,
      requirePricingPolicy: true,
    })({ method: "GET", headers: {} } as never, res);

    expect(readOfferPricing).not.toHaveBeenCalled();
    // A caller that sent no capability headers is an incomplete request, not an
    // unavailable origin; 503 here would page a responder for a client bug.
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({
        code: "BAD_REQUEST",
        details: {
          reason: "pricing_policy_request_invalid",
          stage: "pricing_policy",
          policyReason: "v2_capability_required",
        },
      }),
    }));
  });

  it("serves v2 only through a server-assigned capability path", async () => {
    const res = createResponse();
    const policy = {
      offerPolicyVersion: "commerce.offer-policy.v2" as const,
      promotionEngineVersion: "promotion-engine.v2" as const,
      pricingPolicyToken: "pp1.this-is-a-long-enough-placeholder-token-for-contracts.signature",
    };
    const v2Payload = {
      contractVersion: COMMERCE_OFFER_PRICING_V2_CONTRACT_VERSION,
      scope: "dog_products_and_shipping" as const,
      pricingPolicy: policy,
      products: [price], minimum: { oneTime: price, subscription: price },
      shipping: {
        gross: { amountMinor: 1500, currency: "PLN" as const },
        discountGross: { amountMinor: 1500, currency: "PLN" as const },
        payable: { amountMinor: 0, currency: "PLN" as const },
      },
      minimumProductPayable: { amountMinor: 100, currency: "PLN" as const },
    };
    const readOfferPricing = vi.fn(async () => v2Payload);
    const resolvePricingPolicy = vi.fn(() => policy);
    await createCommerceOfferPricingHandler({ readOfferPricing, resolvePricingPolicy })(
      { method: "GET", headers: {
        "x-commerce-offer-policy-capability": "commerce.offer-policy.v2",
        "x-commerce-visitor-id": "visitor-1",
      } } as never,
      res,
    );

    expect(resolvePricingPolicy).toHaveBeenCalledWith({
      visitorId: "visitor-1",
      pricingPolicy: { capability: "commerce.offer-policy.v2" },
    });
    expect(readOfferPricing).toHaveBeenCalledWith(policy);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control", COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects cache-busting query parameters before loading the projection", async () => {
    const res = createResponse();
    const readOfferPricing = vi.fn(async () => payload);
    await createCommerceOfferPricingHandler({ readOfferPricing })(
      { method: "GET", query: { bust: "1" } } as never,
      res,
    );

    expect(readOfferPricing).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("ignores routing-only query keys supplied by the catch-all entrypoint", async () => {
    const res = createResponse();
    const readOfferPricing = vi.fn(async () => payload);
    await createCommerceOfferPricingHandler({ readOfferPricing })(
      {
        method: "GET",
        query: {
          path: "commerce/offer-pricing",
          __bffPath: "/commerce/offer-pricing",
        },
      } as never,
      res,
    );

    expect(readOfferPricing).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("fails closed when the projection cannot be read", async () => {
    const res = createResponse();
    await createCommerceOfferPricingHandler({
      readOfferPricing: async () => {
        throw new Error("db down");
      },
    })({ method: "GET" } as never, res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
