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

describe("promotion code preview", () => {
  it("shows an exact target 80% price for one-time and initial subscription", () => {
    const preview = previewPromotionCode(input, secret);
    expect(preview.results.map((result) => result.productPayableMinor)).toEqual([2_000, 2_000]);
    expect(preview.results.map((result) => result.effectiveProductDiscountBps)).toEqual([8_000, 8_000]);
    expect(preview.results.every((result) => result.winner === "code")).toBe(true);
  });

  it("signs all semantic preview inputs and rejects tampering", () => {
    const preview = previewPromotionCode(input, secret);
    expect(preview.previewProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyPromotionPreviewProof(input, preview.previewProof, secret)).toBe(true);
    expect(verifyPromotionPreviewProof(
      { ...input, minimumReferenceMinor: 10_001 },
      preview.previewProof,
      secret,
    )).toBe(false);
  });

  it("does not apply a one-time-only code to the subscription preview", () => {
    const preview = previewPromotionCode({ ...input, scopes: ["one_time"] }, secret);
    expect(preview.results[0].winner).toBe("code");
    expect(preview.results[1].winner).toBe("automatic");
    expect(preview.results[1].productPayableMinor).toBe(8_000);
  });

  it("enforces the fixed PLN 1 product floor and minimum-reference eligibility", () => {
    const floor = previewPromotionCode({
      ...input,
      benefits: [{ lane: "product", kind: "fixed_amount", valueMinor: 99_999 }],
    }, secret);
    expect(floor.results.map((result) => result.productPayableMinor)).toEqual([100, 100]);
    const ineligible = previewPromotionCode({ ...input, minimumReferenceMinor: 10_001 }, secret);
    expect(ineligible.results.every((result) => result.winner === "automatic")).toBe(true);
    expect(ineligible.results.every((result) => result.adjustments.length === 0)).toBe(true);
  });

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

  it("uses the live v1 floor rounding at half-minor boundaries", () => {
    const legacy = previewPromotionCode({
      ...input,
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{ lane: "product", kind: "percentage", valueBps: 1_000 }],
      context: {
        referenceProductMinor: 10_005,
        oneTimeProductMinor: 10_005,
        subscriptionProductMinor: 10_005,
        shippingMinor: 0,
      },
    }, secret);
    expect(legacy.results[0].adjustments[0]?.amountOffMinor).toBe(1_000);
    expect(legacy.results[0].productPayableMinor).toBe(9_005);
  });

  it("preserves legacy zero-value definitions as a no-op preview", () => {
    const legacy = previewPromotionCode({
      ...input,
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{ lane: "product", kind: "percentage", valueBps: 0 }],
    }, secret);
    expect(legacy.results.every((result) => result.adjustments.length === 0)).toBe(true);
    expect(legacy.results.map((result) => result.productPayableMinor)).toEqual([10_000, 8_000]);
  });

  it("refuses to sign a preview for an unsupported legacy value", () => {
    expect(() => previewPromotionCode({
      ...input,
      promotionEngineVersion: "promotion-engine.v1",
      benefits: [{
        lane: "product",
        kind: "fixed_amount",
        validationState: "unsupported_legacy_value",
      }],
    }, secret)).toThrowError(new RangeError("promotion_preview_unsupported_legacy_value"));
  });

  it("generates normalized 16-character Crockford codes without ambiguous letters", () => {
    const codes = new Set(Array.from({ length: 256 }, generatePromotionCode));
    expect(codes.size).toBe(256);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(normalizePromotionCode(" summer_80 ")).toBe("SUMMER_80");
  });
});
