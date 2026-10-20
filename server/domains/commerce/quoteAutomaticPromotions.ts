import { createQuoteAutomaticPromotions } from "@openlup/platform/promotions";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { evaluateOrderTotalDiscounts } from "./quotePromoDiscounts.js";
import { evaluateAutomaticPromotionV2, legacyPromotionDataPort } from "./quotePromotionV2.js";
export const { resolveAutomaticQuotePromotions } = createQuoteAutomaticPromotions<CreateQuoteRequest>({
  resolveEmailEligibility: (request) => Boolean(request.customerEligibilityContext?.email ?? request.customerEligibilityContext?.contactEmail),
  evaluateOrderTotalDiscounts, evaluateAutomaticPromotionV2, legacyPromotionDataPort,
});
