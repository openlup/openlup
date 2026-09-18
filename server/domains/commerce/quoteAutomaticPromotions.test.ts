import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { PROMOTION_ENGINE_V2 } from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CreateQuoteOptions } from "../../../src/domains/commerce/ports.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import { resolveAutomaticQuotePromotions } from "./quoteAutomaticPromotions.js";

const mocks = vi.hoisted(() => ({
  evaluateLegacy: vi.fn(),
  evaluateV2: vi.fn(),
  legacyPort: vi.fn((port) => port),
}));

vi.mock("./quotePromoDiscounts.js", () => ({
  evaluateOrderTotalDiscounts: mocks.evaluateLegacy,
}));
vi.mock("./quotePromotionV2.js", () => ({
  evaluateAutomaticPromotionV2: mocks.evaluateV2,
  legacyPromotionDataPort: mocks.legacyPort,
}));

const promoDataPort = {} as CommercePromoDataPort;
const request = {
  mode: "subscription",
  lines: [{ sku: "lamb", quantity: 14 }],
  promoCodes: ["SAVE"],
  visitorId: "visitor-1",
  customerEligibilityContext: { email: "dog@example.com" },
} as CreateQuoteRequest;
const baseInput = {
  request,
  regionCode: "PL" as const,
  referenceProductMinor: 20_860,
  subtotalGrossMinor: 18_760,
  shippingGrossMinor: 0,
  atTime: "2026-07-16T12:00:00.000Z",
};

describe("resolveAutomaticQuotePromotions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateLegacy.mockResolvedValue({ discounts: [], codeRejections: [] });
    mocks.evaluateV2.mockResolvedValue({ discounts: [], codeRejections: [] });
  });

  it("returns an empty result when the promotion port is absent", async () => {
    await expect(resolveAutomaticQuotePromotions(baseInput)).resolves.toEqual({
      discounts: [],
      codeRejections: [],
    });
    expect(mocks.evaluateLegacy).not.toHaveBeenCalled();
    expect(mocks.evaluateV2).not.toHaveBeenCalled();
  });

  it("keeps the legacy evaluator inputs unchanged", async () => {
    await resolveAutomaticQuotePromotions({
      ...baseInput,
      promoDataPort,
      options: { clientId: "client-1" },
    });

    expect(mocks.evaluateLegacy).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      visitorId: "visitor-1",
      mode: "subscription",
      promoCodes: ["SAVE"],
      subtotalGrossMinor: 18_760,
      emailEligibilityConfirmed: true,
    }));
    expect(mocks.evaluateV2).not.toHaveBeenCalled();
  });

  it("dispatches an assigned v2 policy to the v2 evaluator", async () => {
    await resolveAutomaticQuotePromotions({
      ...baseInput,
      promoDataPort,
      options: {
        clientId: "client-1",
        pricingPolicy: { promotionEngineVersion: PROMOTION_ENGINE_V2 },
      } as CreateQuoteOptions,
    });

    expect(mocks.evaluateV2).toHaveBeenCalledWith(expect.objectContaining({
      promoDataPort,
      clientId: "client-1",
      promoCodes: ["SAVE"],
      referenceProductMinor: 20_860,
      currentProductMinor: 18_760,
      shippingMinor: 0,
      emailEligibilityConfirmed: true,
    }));
    expect(mocks.evaluateLegacy).not.toHaveBeenCalled();
  });
});
