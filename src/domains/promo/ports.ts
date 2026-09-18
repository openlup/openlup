// Public compatibility boundary for the promo domain.
//
// Product code keeps importing this path while the future core package boundary
// is rehearsed through the workspace package.
export {
  evaluatePromotionAdjustmentsV2,
  evaluatePromos,
  promoEligibilityFailure,
} from "@openlup/core/promo";
export type {
  AppliedAdjustment,
  AppliedPromotion,
  EvaluateNowInput,
  PromoEvaluationCart,
  PromotionAdjustmentCandidate,
  PromotionAdjustmentContext,
  PromotionAdjustmentResult,
  PromotionAppliesToKind,
  PromotionCodeRejectionReason,
  PromotionDiscountType,
  PromotionRow,
  PromotionStackingRule,
  PromotionTriggerType,
} from "@openlup/core/promo";
export {
  PROMOTION_ADJUSTMENT_KINDS,
  PROMOTION_ADJUSTMENT_LANES,
  PROMOTION_APPLIES_TO_KINDS,
  PROMOTION_DISCOUNT_TYPES,
  PROMOTION_ENGINE_V2,
  PROMOTION_PURCHASE_SCOPES,
  PROMOTION_STACKING_RULES,
  PROMOTION_TRIGGER_TYPES,
} from "@openlup/core/promo";
