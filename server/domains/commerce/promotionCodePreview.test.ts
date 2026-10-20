import { describe, expect, it } from "vitest";
import {
  promotionCodeCreateRequestSchema,
  type PromotionCodePreviewRequest,
} from "../../../src/domains/commerce/adminPromotionCodesContracts.js";

import {
  generatePromotionCode,
  normalizePromotionCode,
  previewPromotionCode,
  verifyPromotionPreviewProof,
} from "./promotionCodePreview.js";

const secret = "test-promotion-preview-secret-at-least-32-bytes";

const input: PromotionCodePreviewRequest = {
  benefits: [{ lane: "product", kind: "target_percentage", valueBps: 8_000 }],
  scopes: ["one_time", "subscription_initial"],
  promotionEngineVersion: "promotion-engine.v2",
  minimumReferenceMinor: 0,
  context: {
    referenceProductMinor: 10_000,
    oneTimeProductMinor: 10_000,
    subscriptionProductMinor: 8_000,
    shippingMinor: 1_500,
  },
};

describe("reference create-schema and preview compatibility", () => {


  it("previews legacy product percentages without accepting them as v2 target definitions", () => {
    const legacy = previewPromotionCode({
      ...input,
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
    }, secret);
    expect(legacy.results.map((result) => result.productPayableMinor)).toEqual([9_000, 7_200]);
    expect(legacy.results.every((result) => result.adjustments[0]?.kind === "percentage")).toBe(true);
    expect(promotionCodeCreateRequestSchema.safeParse({
      name: "Legacy shape",
      code: { kind: "manual", value: "LEGACY10" },
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
      scopes: ["one_time"],
      validFrom: new Date().toISOString(),
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }).success).toBe(false);
    expect(promotionCodeCreateRequestSchema.safeParse({
      name: "Zero v2",
      code: { kind: "manual", value: "ZERO-V2" },
      benefits: [{ lane: "product", kind: "fixed_amount", valueMinor: 0 }],
      scopes: ["one_time"],
      validFrom: new Date().toISOString(),
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
    }).success).toBe(false);
    expect(promotionCodeCreateRequestSchema.safeParse({
      name: "Oversized fixed v2",
      code: { kind: "manual", value: "HUGE-V2" },
      benefits: [{ lane: "product", kind: "fixed_amount", valueMinor: 2_147_483_648 }],
      scopes: ["one_time"],
      validFrom: new Date().toISOString(),
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    }).success).toBe(false);
  });
});
