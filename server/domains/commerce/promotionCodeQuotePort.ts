/** Versioned DB read names owned by the managed adapter. */
export const PROMOTION_CODE_QUOTE_RPC = {
  current: "commerce_promotion_codes_quote_candidates_v2",
  legacy: "commerce_promotion_codes_quote_candidates",
} as const;

export type { ResolvedPromotionCodeCandidate, ResolvePromotionCodeQuoteInput, PromotionCodeQuoteResolution, PromotionCodeQuotePort } from "@openlup/platform/promotions";
