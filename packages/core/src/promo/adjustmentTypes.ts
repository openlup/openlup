/** @beta */
export const PROMOTION_ENGINE_V2 = "promotion-engine.v2" as const;

/** @beta */
export const PROMOTION_PURCHASE_SCOPES = ["one_time", "subscription_initial"] as const;
/** @beta */
export type PromotionPurchaseScope = (typeof PROMOTION_PURCHASE_SCOPES)[number];

/** @beta */
export const PROMOTION_ADJUSTMENT_LANES = ["product", "shipping"] as const;
/** @beta */
export type PromotionAdjustmentLane = (typeof PROMOTION_ADJUSTMENT_LANES)[number];

/** @beta */
export const PROMOTION_ADJUSTMENT_KINDS = [
  "target_percentage",
  "percentage",
  "fixed_amount",
  "free_shipping",
] as const;
/** @beta */
export type PromotionAdjustmentKind = (typeof PROMOTION_ADJUSTMENT_KINDS)[number];

/** @beta */
export type PromotionAdjustmentSource = "automatic" | "code";

interface PromotionAdjustmentCandidateBase {
  promotionId: string;
  name: string;
  scopes: readonly PromotionPurchaseScope[];
}

type PromotionAdjustmentTrigger =
  | { source: "automatic"; codeId?: never; code?: never }
  | { source: "code"; codeId: string; code?: string };

/** An already eligibility-filtered benefit considered by the pure v2 engine. */
/** @beta */
export type PromotionAdjustmentCandidate = PromotionAdjustmentCandidateBase & PromotionAdjustmentTrigger & (
  | { lane: "product"; kind: "target_percentage"; valueBps: number; valueMinor?: never }
  | { lane: "product"; kind: "fixed_amount"; valueMinor: number; valueBps?: never }
  | { lane: "shipping"; kind: "percentage"; valueBps: number; valueMinor?: never }
  | { lane: "shipping"; kind: "fixed_amount"; valueMinor: number; valueBps?: never }
  | { lane: "shipping"; kind: "free_shipping"; valueBps?: never; valueMinor?: never }
);

/** @beta */
export interface PromotionAdjustmentContext {
  purchaseScope: PromotionPurchaseScope;
  /** Product price before bundle, subscription, or acquisition benefits. */
  referenceProductMinor: number;
  /** Product price after automatic pricing benefits, before a v2 promotion. */
  currentProductMinor: number;
  shippingMinor: number;
  /** Required adopter policy, expressed in the checkout currency's minor units. */
  minimumProductPayableMinor: number;
}

/** @beta */
export interface AppliedAdjustment {
  engineVersion: typeof PROMOTION_ENGINE_V2;
  promotionId: string;
  codeId?: string;
  code?: string;
  name: string;
  source: PromotionAdjustmentSource;
  lane: PromotionAdjustmentLane;
  kind: PromotionAdjustmentKind;
  amountOffMinor: number;
  beforeMinor: number;
  afterMinor: number;
  floorApplied: boolean;
  targetEffectiveDiscountBps?: number;
}

/** @beta */
export type PromotionCodeRejectionReason = "scope_not_applicable" | "better_price_exists";

/** @beta */
export interface PromotionCodeRejection {
  codeId?: string;
  code?: string;
  reason: PromotionCodeRejectionReason;
}

/** @beta */
export interface PromotionAdjustmentResult {
  engineVersion: typeof PROMOTION_ENGINE_V2;
  adjustments: AppliedAdjustment[];
  rejectedCodes: PromotionCodeRejection[];
  productPayableMinor: number;
  shippingPayableMinor: number;
  effectiveProductDiscountBps: number;
}
