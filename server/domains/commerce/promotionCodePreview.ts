import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  PromotionCodeBenefit,
  PromotionCodePreviewRequest,
  PromotionCodePreviewResponse,
} from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import {
  evaluatePromotionAdjustmentsV2,
  type PromotionAdjustmentCandidate,
} from "../../../src/domains/promo/ports.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PROMOTION_ENGINE_VERSION = "promotion-engine.v2" as const;
/**
 * The smallest amount a product line may be sold for, in minor units, for this
 * deployment. It used to be the literal `100`, written out again at three other
 * call sites — and `100` is not a floor, it is *one major unit* frozen at an
 * exponent of two. In a currency without hundredths the same literal is a
 * hundredfold overstatement of a customer-facing minimum. The settlement profile
 * derives it from the currency's own exponent instead, so a zero-exponent
 * deployment gets 1 and this one still gets 100.
 *
 * Read once at module evaluation, like the other settlement defaults on the
 * server: a misconfigured floor should stop the process, not the first customer.
 */
export const MINIMUM_PRODUCT_PAYABLE_MINOR =
  readSettlementProfile(process.env).minimumProductPayableMinor;

export function generatePromotionCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let buffer = 0;
  let code = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += CROCKFORD_BASE32[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return code;
}

export function normalizePromotionCode(code: string): string {
  return code.trim().toUpperCase();
}

export function promotionPreviewProof(input: PromotionCodePreviewRequest, secret: string): string {
  assertPreviewSecret(secret);
  assertSupportedPreviewBenefits(input);
  return createHmac("sha256", secret).update(previewProofPayload(input)).digest("base64url");
}

export function verifyPromotionPreviewProof(
  input: PromotionCodePreviewRequest,
  proof: string,
  secret: string,
): boolean {
  const expected = promotionPreviewProof(input, secret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(proof);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function previewPromotionCode(
  input: PromotionCodePreviewRequest,
  secret: string,
): PromotionCodePreviewResponse {
  assertSupportedPreviewBenefits(input);
  const eligible = input.context.referenceProductMinor >= input.minimumReferenceMinor;
  const results = (["one_time", "subscription_initial"] as const).map((scope) => {
    const currentProductMinor =
      scope === "one_time"
        ? input.context.oneTimeProductMinor
        : input.context.subscriptionProductMinor;
    const candidates = eligible
      ? input.benefits
        .map((benefit) => toCandidate(benefit, input.scopes, currentProductMinor))
        .filter((candidate): candidate is PromotionAdjustmentCandidate => candidate !== null)
      : [];
    const result = evaluatePromotionAdjustmentsV2(
      {
        purchaseScope: scope,
        referenceProductMinor: input.context.referenceProductMinor,
        currentProductMinor,
        shippingMinor: input.context.shippingMinor,
        minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
      },
      candidates,
    );
    return {
      scope,
      productPayableMinor: result.productPayableMinor,
      shippingPayableMinor: result.shippingPayableMinor,
      effectiveProductDiscountBps: result.effectiveProductDiscountBps,
      winner: result.adjustments.some((adjustment) => adjustment.source === "code")
        ? ("code" as const)
        : ("automatic" as const),
      floorApplied: result.adjustments.some((adjustment) => adjustment.floorApplied),
      adjustments: result.adjustments.map((adjustment) => ({
        lane: adjustment.lane,
        kind: input.promotionEngineVersion === "promotion-engine.v1"
          && adjustment.promotionId === "preview-product"
          && input.benefits.some((benefit) => benefit.lane === "product" && benefit.kind === "percentage")
          ? ("percentage" as const)
          : adjustment.kind,
        amountOffMinor: adjustment.amountOffMinor,
        beforeMinor: adjustment.beforeMinor,
        afterMinor: adjustment.afterMinor,
      })),
    };
  });
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    promotionEngineVersion: input.promotionEngineVersion,
    previewProof: promotionPreviewProof(input, secret),
    results,
  };
}

function previewProofPayload(input: PromotionCodePreviewRequest): string {
  return stableJson({
    promotionEngineVersion: input.promotionEngineVersion,
    minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
    minimumReferenceMinor: input.minimumReferenceMinor,
    benefits: input.benefits,
    scopes: input.scopes,
    context: input.context,
  });
}

function assertPreviewSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new RangeError("promotion_preview_secret_too_short");
  }
}

function assertSupportedPreviewBenefits(input: PromotionCodePreviewRequest): void {
  if (input.benefits.some((benefit) => "validationState" in benefit)) {
    throw new RangeError("promotion_preview_unsupported_legacy_value");
  }
}

function toCandidate(
  benefit: PromotionCodeBenefit,
  scopes: PromotionCodePreviewRequest["scopes"],
  currentProductMinor: number,
): PromotionAdjustmentCandidate | null {
  const base = {
    promotionId: `preview-${benefit.lane}`,
    codeId: "preview-code",
    source: "code" as const,
    name: "Promotion code preview",
    scopes,
  };
  if ("validationState" in benefit) {
    throw new RangeError("promotion_preview_unsupported_legacy_value");
  }
  if (("valueBps" in benefit && benefit.valueBps === 0)
      || ("valueMinor" in benefit && benefit.valueMinor === 0)) return null;
  if (benefit.kind === "target_percentage") return { ...base, ...benefit };
  if (benefit.kind === "percentage" && benefit.lane === "product") {
    const valueMinor = benefit.valueBps >= 10_000
      ? currentProductMinor
      : Number((BigInt(currentProductMinor) * BigInt(benefit.valueBps)) / 10_000n);
    return {
      ...base,
      lane: "product",
      kind: "fixed_amount",
      valueMinor,
    };
  }
  if (benefit.kind === "percentage" && benefit.lane === "shipping" && benefit.valueBps >= 10_000) {
    return { ...base, lane: "shipping", kind: "free_shipping" };
  }
  if (benefit.kind === "percentage") return { ...base, ...benefit };
  if (benefit.kind === "fixed_amount") return { ...base, ...benefit };
  return { ...base, ...benefit };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
