import { createPromotionQuoteAcceptance } from "@openlup/platform/promotions";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
export { PROMOTION_ACCEPTANCE_MAX_TTL_MS, PROMOTION_ACCEPTANCE_CLOCK_SKEW_MS } from "@openlup/platform/promotions";
export type { PromotionAcceptanceKeyring, PromotionAcceptanceDiagnostic } from "@openlup/platform/promotions";
export const { issuePromotionQuoteAcceptance, issuePromotionQuoteAcceptanceWithOutcome, verifyPromotionQuoteAcceptance, verifyPromotionQuoteAcceptanceWithOutcome } = createPromotionQuoteAcceptance<CreateQuoteRequest>({
  projectRequest: (request) => ({
    mode: request.mode,
    cadenceDays: request.cadenceDays ?? null,
    lines: request.lines.map((line) => ({
      sku: line.sku, quantity: line.quantity, variantId: line.variantId ?? null,
      modeAtLine: line.modeAtLine ?? request.mode,
    })),
    sizeConstraint: request.sizeConstraint ? {
      kind: request.sizeConstraint.kind,
      value: request.sizeConstraint.value,
      dailyKcalOverride: request.sizeConstraint.dailyKcalOverride ?? null,
    } : null,
    visitorId: request.visitorId ?? null,
    customerEmail: request.customerEligibilityContext?.email?.trim().toLowerCase() ?? null,
  }),
});
