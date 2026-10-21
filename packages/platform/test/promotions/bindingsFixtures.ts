import { createQuotePromoDiscounts, createQuotePromotionV2, createQuoteAutomaticPromotions, createQuotePromotionCodeAdjustments, createPromotionCodePreview, createPromotionQuoteAcceptance } from "../../src/promotions/index.js";
import type { CreateQuoteRequest } from "../pricing/quoteSchemaFixtures.js";
import { promotionCustomerSemantic } from "./semanticFixtures.js";
export const { evaluateOrderTotalDiscounts } = createQuotePromoDiscounts({ promotionCustomerSemantic });
export const { evaluateAutomaticPromotionV2, legacyPromotionDataPort } = createQuotePromotionV2({ promotionCustomerSemantic, minimumProductPayableMinor: 100, evaluateOrderTotalDiscounts });
export const { resolveAutomaticQuotePromotions } = createQuoteAutomaticPromotions<CreateQuoteRequest>({
  resolveEmailEligibility: request => Boolean(request.customerEligibilityContext?.email ?? request.customerEligibilityContext?.contactEmail),
  evaluateOrderTotalDiscounts, evaluateAutomaticPromotionV2, legacyPromotionDataPort,
});
export const { applyPromotionCodesV2, mapEngineRejectionReason } = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: 100 });
export const { generatePromotionCode, normalizePromotionCode, promotionPreviewProof, verifyPromotionPreviewProof, previewPromotionCode } = createPromotionCodePreview({ minimumProductPayableMinor: 100 });
export const { issuePromotionQuoteAcceptance, issuePromotionQuoteAcceptanceWithOutcome, verifyPromotionQuoteAcceptance, verifyPromotionQuoteAcceptanceWithOutcome } = createPromotionQuoteAcceptance<CreateQuoteRequest>({ projectRequest: request => ({
    mode: request.mode,
    cadenceDays: request.cadenceDays ?? null,
    lines: request.lines.map((line) => ({
      sku: line.sku, quantity: line.quantity, variantId: line.variantId ?? null,
      modeAtLine: line.modeAtLine ?? request.mode,
    })),
    sizeConstraint: request.sizeConstraint ? {
      kind: request.sizeConstraint.kind,
      value: request.sizeConstraint.value,
      dailyUsageOverride: request.sizeConstraint.dailyUsageOverride ?? null,
    } : null,
    visitorId: request.visitorId ?? null,
    customerEmail: request.customerEligibilityContext?.email?.trim().toLowerCase() ?? null,
  }) });
export { PROMOTION_ACCEPTANCE_MAX_TTL_MS, PROMOTION_ACCEPTANCE_CLOCK_SKEW_MS } from "../../src/promotions/index.js";
