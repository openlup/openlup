import type {
  PromotionAdjustmentCandidate,
  PromotionPurchaseScope,
} from "@openlup/core/promo";
import type {
  CommerceCodeRejection,
  CommerceCodeRejectionDetail,
} from "../pricing/index.js";

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
