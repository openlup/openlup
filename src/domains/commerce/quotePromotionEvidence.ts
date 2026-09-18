import { z } from "../../lib/validation/zod.js";

interface QuotePromotionEvidence {
  promotionId: string;
  code?: string | null;
  reasonCode: string;
  promotionEngineVersion?: "promotion-engine.v2";
  promotionCodeId?: string;
  promotionCodeRevision?: number;
  promotionDefinitionFingerprint?: string;
  promotionCodeScopes?: Array<"one_time" | "subscription_initial">;
  promotionMinimumReferenceMinor?: number;
  promotionCodeValidTo?: string | null;
  promotionBenefitKind?: "target_percentage" | "percentage" | "fixed_amount" | "free_shipping";
  promotionBenefitValueBps?: number;
  promotionBenefitValueMinor?: number;
  floorApplied?: boolean;
}

const uuidSchema = z.string().uuid();

export const quoteDiscountSchema = z
  .object({
    promotionId: z.string().trim().min(1).max(120),
    code: z.string().trim().min(1).max(80).nullable().optional(),
    label: z.string().trim().min(1).max(200).optional(),
    appliesTo: z.enum(["order_total", "line", "shipping"]),
    amountOffMinor: z.number().int().positive(),
    reasonCode: z.string().trim().min(1).max(120),
    customerSemantic: z.enum([
      "first_purchase_10", "first_subscription_50", "bundle_5",
    ]).optional(),
    promotionEngineVersion: z.literal("promotion-engine.v2").optional(),
    promotionCodeId: z.string().uuid().optional(),
    promotionCodeRevision: z.number().int().positive().optional(),
    promotionDefinitionFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    promotionCodeScopes: z.array(z.enum(["one_time", "subscription_initial"])).min(1).max(2).optional(),
    promotionMinimumReferenceMinor: z.number().int().nonnegative().optional(),
    promotionCodeValidTo: z.string().datetime({ offset: true }).nullable().optional(),
    promotionBenefitKind: z.enum([
      "target_percentage", "percentage", "fixed_amount", "free_shipping",
    ]).optional(),
    promotionBenefitValueBps: z.number().int().min(1).max(9_999).optional(),
    promotionBenefitValueMinor: z.number().int().positive().optional(),
    floorApplied: z.boolean().optional(),
  })
  .strict()
  .superRefine((discount, context) => {
    if (!hasValidV2PromotionEvidence(discount)) {
      context.addIssue({ code: "custom", message: "v2 promotion discount evidence is incomplete" });
    }
  });

export function hasValidV2PromotionEvidence(discount: QuotePromotionEvidence): boolean {
  const carriesEvidence = discount.promotionEngineVersion !== undefined ||
    discount.promotionCodeId !== undefined ||
    discount.promotionCodeRevision !== undefined ||
    discount.promotionDefinitionFingerprint !== undefined ||
    discount.promotionCodeScopes !== undefined ||
    discount.promotionMinimumReferenceMinor !== undefined ||
    discount.promotionCodeValidTo !== undefined ||
    discount.promotionBenefitKind !== undefined ||
    discount.promotionBenefitValueBps !== undefined ||
    discount.promotionBenefitValueMinor !== undefined || discount.floorApplied !== undefined;
  return !carriesEvidence || (
    discount.promotionEngineVersion === "promotion-engine.v2" &&
    discount.reasonCode === "promotion_code_v2" &&
    Boolean(discount.code) &&
    uuidSchema.safeParse(discount.promotionCodeId).success &&
    discount.promotionCodeRevision !== undefined &&
    /^[0-9a-f]{64}$/.test(discount.promotionDefinitionFingerprint ?? "") &&
    validScopes(discount.promotionCodeScopes) &&
    (discount.promotionMinimumReferenceMinor ?? -1) >= 0 &&
    discount.promotionCodeValidTo !== undefined &&
    discount.promotionBenefitKind !== undefined &&
    benefitValueMatchesKind(discount) &&
    discount.floorApplied !== undefined &&
    uuidSchema.safeParse(discount.promotionId).success
  );
}

function validScopes(scopes: QuotePromotionEvidence["promotionCodeScopes"]): boolean {
  return Boolean(scopes?.length && scopes.length <= 2 &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => scope === "one_time" || scope === "subscription_initial"));
}

function benefitValueMatchesKind(discount: QuotePromotionEvidence): boolean {
  const percentage = discount.promotionBenefitKind === "target_percentage" ||
    discount.promotionBenefitKind === "percentage";
  return percentage === (discount.promotionBenefitValueBps !== undefined) &&
    (discount.promotionBenefitKind === "fixed_amount") ===
      (discount.promotionBenefitValueMinor !== undefined) &&
    (discount.promotionBenefitKind !== "free_shipping" ||
      (discount.promotionBenefitValueBps === undefined &&
       discount.promotionBenefitValueMinor === undefined));
}
