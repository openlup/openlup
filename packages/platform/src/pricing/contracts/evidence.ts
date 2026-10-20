/** UI-safe, additive explanation for a frozen `codeRejections` item. */
export type CommerceCodeRejectionDetail =
  | { code: string; reason: "scope_not_applicable"; allowedScopes: Array<"one_time" | "subscription_initial"> }
  | { code: string; reason: "minimum_not_met"; minimumReferenceMinor: number }
  | { code: string; reason: "not_yet_active"; validFrom: string }
  | { code: string; reason: "global_limit_reached" };


export interface QuotePromotionEvidence {
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

