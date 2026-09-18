import { describe, expect, it, vi } from "vitest";

import type { CommerceQuoteDiscount } from "../../../src/domains/commerce/types.js";
import type {
  PromotionCodeQuotePort,
  ResolvedPromotionCodeCandidate,
} from "./promotionCodeQuotePort.js";
import {
  applyPromotionCodesV2,
  mapEngineRejectionReason,
} from "./quotePromotionCodeAdjustments.js";
import type { PromotionCodeRejectionReason } from "../../../src/domains/promo/ports.js";

const CODE_ID = "11111111-1111-4111-8111-111111111111";
const PROMOTION_ID = "22222222-2222-4222-8222-222222222222";

describe("checkout promotion-code adjustments", () => {
  it("keeps the current subscription 50% mechanics byte-for-byte when v2 is off", async () => {
    const legacy = [
      { ...legacyDiscount(1_000), promotionId: "legacy-upper", code: "SAVE80" },
      { ...legacyDiscount(6_000), promotionId: "legacy-lower", code: "save80" },
    ];

    await expect(applyPromotionCodesV2(baseInput({
      port: undefined,
      mode: "subscription",
      discounts: legacy,
      promoCodes: ["SAVE80"],
    }))).resolves.toEqual({ discounts: legacy, codeRejections: [], codeRejectionDetails: [] });
  });

  it.each(["one_time", "subscription"] as const)(
    "makes an 80%% code target-effective for %s without stacking percentages",
    async (mode) => {
      const automaticDiscount = mode === "subscription" ? 5_000 : 0;
      const result = await applyPromotionCodesV2(baseInput({
        mode,
        discounts: automaticDiscount ? [legacyDiscount(automaticDiscount)] : [],
        port: resolver(productCandidate({ valueBps: 8_000 })),
      }));

      expect(result.discounts.reduce((sum, item) => sum + item.amountOffMinor, 0)).toBe(8_000);
      expect(result.discounts.at(-1)).toMatchObject({
        code: "SAVE80",
        amountOffMinor: mode === "subscription" ? 3_000 : 8_000,
        reasonCode: "promotion_code_v2",
        promotionEngineVersion: "promotion-engine.v2",
        promotionCodeRevision: 7,
      });
    },
  );

  it("surfaces better_price_exists when an eligible code is outranked by the automatic price", async () => {
    const legacy = [legacyDiscount(5_000)];
    const candidate = productCandidate({ valueBps: 4_000 });
    const port = resolver(candidate);
    vi.mocked(port.resolve).mockResolvedValue({
      candidates: [candidate], codeRejections: [],
      codeRejectionDetails: [{ code: "SAVE80", reason: "scope_not_applicable", allowedScopes: ["one_time"] }],
    });
    const result = await applyPromotionCodesV2(baseInput({
      mode: "subscription",
      discounts: legacy,
      codeRejections: [{ code: "save80", reason: "not_recognized" }],
      port,
    }));

    // The weaker code is in-scope but outranked, so the engine's better_price_exists
    // reason must reach the customer instead of collapsing to generic not_eligible.
    expect(result.discounts).toEqual(legacy);
    expect(result.codeRejections).toEqual([{ code: "SAVE80", reason: "better_price_exists" }]);
    expect(result.codeRejectionDetails).toEqual([]);
  });

  it("passes scope_not_applicable through when the code's scope excludes the purchase", async () => {
    const result = await applyPromotionCodesV2(baseInput({
      mode: "one_time",
      port: resolver(productCandidate({ valueBps: 8_000, scopes: ["subscription_initial"] })),
    }));

    expect(result.discounts).toEqual([]);
    expect(result.codeRejections).toEqual([{ code: "SAVE80", reason: "scope_not_applicable" }]);
  });

  it("propagates RPC presentation details without changing rejection compatibility", async () => {
    const port: PromotionCodeQuotePort = {
      resolve: vi.fn().mockResolvedValue({
        candidates: [],
        codeRejections: [{ code: "SAVE80", reason: "not_eligible" }],
        codeRejectionDetails: [{
          code: "SAVE80",
          reason: "scope_not_applicable",
          allowedScopes: ["one_time"],
        }],
      }),
    };

    await expect(applyPromotionCodesV2(baseInput({
      mode: "subscription",
      port,
    }))).resolves.toEqual({
      discounts: [],
      codeRejections: [{ code: "SAVE80", reason: "not_eligible" }],
      codeRejectionDetails: [{
        code: "SAVE80",
        reason: "scope_not_applicable",
        allowedScopes: ["one_time"],
      }],
    });
  });

  it("does not attach v2 rejection state to an already-applied legacy collision code", async () => {
    const port: PromotionCodeQuotePort = {
      resolve: vi.fn().mockResolvedValue({
        candidates: [],
        codeRejections: [{ code: "SAVE10", reason: "not_recognized" }],
        codeRejectionDetails: [{
          code: "SAVE10",
          reason: "scope_not_applicable",
          allowedScopes: ["one_time"],
        }],
      }),
    };
    const appliedLegacy = { ...legacyDiscount(1_000), code: "save10" };

    await expect(applyPromotionCodesV2(baseInput({
      port,
      promoCodes: ["SAVE10"],
      discounts: [appliedLegacy],
      codeRejections: [{ code: "SAVE10", reason: "not_recognized" }],
      codeRejectionDetails: [{
        code: "SAVE10",
        reason: "scope_not_applicable",
        allowedScopes: ["one_time"],
      }],
    }))).resolves.toEqual({
      discounts: [{ ...appliedLegacy, code: "SAVE10" }],
      codeRejections: [],
      codeRejectionDetails: [],
    });
  });

  it("maps engine reasons 1:1 and falls back to not_eligible for an unknown reason", () => {
    expect(mapEngineRejectionReason("better_price_exists")).toBe("better_price_exists");
    expect(mapEngineRejectionReason("scope_not_applicable")).toBe("scope_not_applicable");
    // A reason the engine might add later must never reach the quote schema unmapped.
    expect(mapEngineRejectionReason("future_reason" as PromotionCodeRejectionReason)).toBe("not_eligible");
  });

  it("removes the legacy not-recognized result when the v2 engine applies the same code", async () => {
    const result = await applyPromotionCodesV2(baseInput({
      codeRejections: [{ code: "save80", reason: "not_recognized" }],
      port: resolver(productCandidate({ valueBps: 8_000 })),
    }));

    expect(result.discounts).toEqual([
      expect.objectContaining({ code: "SAVE80", amountOffMinor: 8_000 }),
    ]);
    expect(result.codeRejections).toEqual([]);
  });

  it("replaces a matching interim legacy discount with one full v2 code adjustment", async () => {
    const result = await applyPromotionCodesV2(baseInput({
      discounts: [{ ...legacyDiscount(1_000), code: "SAVE80" }],
      port: resolver(productCandidate({ valueBps: 8_000 })),
    }));

    // The v2 target is calculated from the base before this same identity's
    // legacy interim discount, then replaces it. Two code-bearing components
    // would both misstate the applied outcome and risk a double claim later.
    expect(result.discounts).toEqual([expect.objectContaining({
      code: "SAVE80",
      amountOffMinor: 8_000,
      promotionEngineVersion: "promotion-engine.v2",
    })]);
    expect(result.codeRejections).toEqual([]);
  });

  it("normalizes a v2 identity to its first submitted spelling before resolution", async () => {
    const port = resolver(productCandidate({ code: "SAVE80", valueBps: 8_000 }));

    const result = await applyPromotionCodesV2(baseInput({
      promoCodes: ["save80", "SAVE80"],
      port,
    }));

    expect(port.resolve).toHaveBeenCalledWith(expect.objectContaining({ codes: ["save80"] }));
    expect(result.discounts).toEqual([expect.objectContaining({ code: "save80" })]);
    expect(result.codeRejections).toEqual([]);
  });

  it("orders submitted rejection outcomes while preserving unsubmitted slots", async () => {
    const result = await applyPromotionCodesV2(baseInput({
      promoCodes: ["SECOND", "FIRST"],
      port: {
        resolve: vi.fn().mockResolvedValue({
          candidates: [],
          codeRejections: [{ code: "OLD", reason: "not_recognized" }, { code: "FIRST", reason: "not_recognized" }, { code: "SECOND", reason: "not_recognized" }],
          codeRejectionDetails: [
            { code: "OLD", reason: "scope_not_applicable", allowedScopes: ["one_time"] },
            { code: "FIRST", reason: "scope_not_applicable", allowedScopes: ["one_time"] },
            { code: "SECOND", reason: "scope_not_applicable", allowedScopes: ["one_time"] },
          ],
        }),
      },
    }));

    expect(result.codeRejections.map(({ code }) => code)).toEqual(["OLD", "SECOND", "FIRST"]);
    expect(result.codeRejectionDetails.map(({ code }) => code)).toEqual(["OLD", "SECOND", "FIRST"]);
  });

  it("caps the product at PLN 1 while allowing shipping to reach zero", async () => {
    const port = resolver(
      productCandidate({ valueBps: 9_999 }),
      shippingCandidate(),
    );
    const result = await applyPromotionCodesV2(baseInput({
      port,
      referenceProductMinor: 101,
      subtotalGrossMinor: 101,
      shippingGrossMinor: 990,
    }));

    expect(result.discounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ appliesTo: "order_total", amountOffMinor: 1, floorApplied: true }),
      expect.objectContaining({ appliesTo: "shipping", amountOffMinor: 990, floorApplied: false }),
    ]));
  });

  it("uses the checkout identity and initial-subscription scope for advisory resolution", async () => {
    const port = resolver(productCandidate({ valueBps: 8_000 }));

    await applyPromotionCodesV2(baseInput({ mode: "subscription", port }));

    expect(port.resolve).toHaveBeenCalledWith({
      codes: ["SAVE80"],
      clientId: "33333333-3333-4333-8333-333333333333",
      purchaseScope: "subscription_initial",
      referenceProductMinor: 10_000,
      atTime: "2026-07-14T10:00:00.000Z",
    });
  });
});

function baseInput(overrides: Partial<Parameters<typeof applyPromotionCodesV2>[0]> = {}) {
  return {
    clientId: "33333333-3333-4333-8333-333333333333",
    mode: "one_time" as const,
    promoCodes: ["SAVE80"],
    referenceProductMinor: 10_000,
    subtotalGrossMinor: 10_000,
    shippingGrossMinor: 0,
    discounts: [] as CommerceQuoteDiscount[],
    codeRejections: [],
    atTime: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

function legacyDiscount(amountOffMinor: number): CommerceQuoteDiscount {
  return {
    promotionId: "legacy-subscription",
    label: "Existing automatic price",
    appliesTo: "order_total",
    amountOffMinor,
    reasonCode: "promo:existing",
  };
}

function productCandidate(overrides: Partial<ResolvedPromotionCodeCandidate> = {}): ResolvedPromotionCodeCandidate {
  return {
    promotionId: PROMOTION_ID,
    codeId: CODE_ID,
    code: "SAVE80",
    codeRevision: 7,
    definitionFingerprint: "a".repeat(64),
    minimumReferenceMinor: 0,
    validTo: "2026-07-17T00:00:00.000Z",
    name: "Target 80",
    source: "code",
    lane: "product",
    kind: "target_percentage",
    valueBps: 8_000,
    scopes: ["one_time", "subscription_initial"],
    ...overrides,
  } as ResolvedPromotionCodeCandidate;
}

function shippingCandidate(): ResolvedPromotionCodeCandidate {
  return {
    promotionId: "44444444-4444-4444-8444-444444444444",
    codeId: CODE_ID,
    code: "SAVE80",
    codeRevision: 7,
    definitionFingerprint: "a".repeat(64),
    minimumReferenceMinor: 0,
    validTo: "2026-07-17T00:00:00.000Z",
    name: "Free shipping",
    source: "code",
    lane: "shipping",
    kind: "free_shipping",
    scopes: ["one_time", "subscription_initial"],
  };
}

function resolver(...candidates: ResolvedPromotionCodeCandidate[]): PromotionCodeQuotePort {
  return {
    resolve: vi.fn().mockResolvedValue({ candidates, codeRejections: [], codeRejectionDetails: [] }),
  };
}
