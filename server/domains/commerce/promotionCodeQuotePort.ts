import type {
  PromotionAdjustmentCandidate,
  PromotionPurchaseScope,
} from "../../../src/domains/promo/types.js";
import type {
  CommerceCodeRejection,
  CommerceCodeRejectionDetail,
} from "../../../src/domains/commerce/types.js";

/** Versioned DB read names shared by the port contract and its Supabase adapter. */
export const PROMOTION_CODE_QUOTE_RPC = {
  current: "commerce_promotion_codes_quote_candidates_v2",
  legacy: "commerce_promotion_codes_quote_candidates",
} as const;

export type ResolvedPromotionCodeCandidate = PromotionAdjustmentCandidate & {
  codeRevision: number;
  definitionFingerprint: string;
  minimumReferenceMinor: number;
  validTo: string | null;
};

export interface ResolvePromotionCodeQuoteInput {
  codes: readonly string[];
  clientId: string | null;
  purchaseScope: PromotionPurchaseScope;
  referenceProductMinor: number;
  atTime: string;
}

export interface PromotionCodeQuoteResolution {
  candidates: ResolvedPromotionCodeCandidate[];
  codeRejections: CommerceCodeRejection[];
  /** Additive v2 RPC detail; old RPC fallback returns an empty array. */
  codeRejectionDetails: CommerceCodeRejectionDetail[];
}

/** Advisory quote read only. Capacity is authoritatively claimed by the order transaction. */
export interface PromotionCodeQuotePort {
  resolve(input: ResolvePromotionCodeQuoteInput): Promise<PromotionCodeQuoteResolution>;
}
