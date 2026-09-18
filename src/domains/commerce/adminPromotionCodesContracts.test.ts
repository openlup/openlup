import { describe, expect, it } from "vitest";

import {
  promotionCodeCreateRequestSchema,
  promotionCodePreviewRequestSchema,
} from "./adminPromotionCodesContracts.js";

describe("admin promotion code contracts", () => {
  it("rejects 100 percent and duplicate-lane benefit definitions", () => {
    const base = {
      scopes: ["one_time"],
      context: {
        referenceProductMinor: 1_000,
        oneTimeProductMinor: 1_000,
        subscriptionProductMinor: 900,
        shippingMinor: 0,
      },
    };
    expect(promotionCodePreviewRequestSchema.safeParse({
      ...base,
      benefits: [{ lane: "product", kind: "target_percentage", valueBps: 10_000 }],
    }).success).toBe(false);
    expect(promotionCodePreviewRequestSchema.safeParse({
      ...base,
      benefits: [
        { lane: "product", kind: "target_percentage", valueBps: 5_000 },
        { lane: "product", kind: "fixed_amount", valueMinor: 100 },
      ],
    }).success).toBe(false);
  });

  it("requires backend preview evidence before active creation", () => {
    const parsed = promotionCodeCreateRequestSchema.safeParse({
      name: "Launch",
      code: { kind: "automatic" },
      benefits: [{ lane: "shipping", kind: "free_shipping" }],
      scopes: ["one_time"],
      validFrom: "2026-07-14T10:00:00.000Z",
      validTo: null,
      status: "active",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.success).toBe(false);
  });
});
