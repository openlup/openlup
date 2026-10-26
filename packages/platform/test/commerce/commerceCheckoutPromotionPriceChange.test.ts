import { describe, expect, it, vi } from "vitest";
import type { HttpResponse } from "../../src/http/index.js";
import {
  rejectMissingPromotionExpectedQuote,
  respondToPromotionCodePriceChange,
} from "./checkoutTestFixtures.js";
import { intent, quoteSnapshot, type Snapshot } from "./checkoutTestFixtures.js";

function response(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("promotion checkout price-change response", () => {
  it("rejects missing expected quote only while v2 acceptance is enforced", () => {
    const res = response();
    expect(rejectMissingPromotionExpectedQuote({
      res, enforced: false, intent: { ...intent(), promoCodes: ["LEGACY10"] },
    })).toBe(false);
    expect(rejectMissingPromotionExpectedQuote({
      res, enforced: true, intent: { ...intent(), promoCodes: ["SAVE80"] },
    })).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("re-quotes a lost atomic claim into the existing price_changed envelope", async () => {
    const res = response();
    const authoritativeQuote = quoteSnapshot({ amountMinor: 5000, currency: "XTS" });
    const result = await respondToPromotionCodePriceChange({
      res,
      quotePort: { createQuote: vi.fn().mockResolvedValue(authoritativeQuote) },
      intent: { ...intent(), promoCodes: ["SAVE80"] },
      provisioned: { clientId: "client-1", replayed: false, addressId: "address-1" },
      checkoutKind: "one_time",
      expectedQuote: { totalGross: { amountMinor: 2000, currency: "XTS" } },
      acceptedQuoteSnapshot: quoteSnapshot({ amountMinor: 2000, currency: "XTS" }),
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });
    expect(result).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "price_changed",
        authoritativeQuote,
      }),
    }));
  });

  it("preserves the assigned offer policy when re-quoting a lost atomic claim", async () => {
    const res = response();
    const pricingPolicy = {
      offerPolicyVersion: "commerce.offer-policy.v2" as const,
      promotionEngineVersion: "promotion-engine.v2" as const,
      pricingPolicyToken: "pp1.test.test",
    };
    const authoritativeQuote = quoteSnapshot({ amountMinor: 5000, currency: "XTS" });
    const createQuote = vi.fn().mockResolvedValue(authoritativeQuote);
    const resolvePricingPolicy = vi.fn().mockReturnValue(pricingPolicy);

    await respondToPromotionCodePriceChange({
      res,
      quotePort: { createQuote },
      intent: { ...intent(), promoCodes: ["SAVE80"] },
      provisioned: { clientId: "client-1", replayed: false, addressId: "address-1" },
      checkoutKind: "subscription_initial",
      expectedQuote: {
        totalGross: { amountMinor: 2000, currency: "XTS" },
        pricingPolicy,
      },
      acceptedQuoteSnapshot: quoteSnapshot({ amountMinor: 2000, currency: "XTS" }),
      resolvePricingPolicy,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(resolvePricingPolicy).toHaveBeenCalledWith(expect.objectContaining({
      pricingPolicy: expect.objectContaining({ token: pricingPolicy.pricingPolicyToken }),
    }));
    expect(createQuote).toHaveBeenCalledWith(expect.any(Object), {
      clientId: "client-1",
      pricingPolicy,
    });
  });
  it("re-quotes a bound order with the accepted offer version", async () => {
    const createQuote = vi.fn().mockResolvedValue(quoteSnapshot());
    const accepted = quoteSnapshot();
    const acceptedQuoteSnapshot: Snapshot = {
      ...accepted,
      quote: {
        ...accepted.quote,
        context: {
          mode: "one_time",
          cadenceDays: null,
          promoCodes: ["SAVE80"],
          offerVersion: "offer.v2",
          offerEvidence: { tier: "b" },
        },
      },
    };

    await respondToPromotionCodePriceChange({
      res: response(),
      quotePort: { createQuote },
      intent: { ...intent(), promoCodes: ["SAVE80"], offerVersion: "offer.v2", minimumUnits: 14 },
      provisioned: { clientId: "client-1", replayed: false, addressId: "address-1" },
      checkoutKind: "one_time",
      acceptedQuoteSnapshot,
      recordQuote: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(createQuote).toHaveBeenCalledWith(expect.any(Object), {
      clientId: "client-1",
      offerVersion: "offer.v2",
    });
  });
});
