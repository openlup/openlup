import { createQuotePromoDiscounts } from "@openlup/platform/promotions";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";
export type { QuoteDiscountResult } from "@openlup/platform/promotions";
// Incumbent reference policy; classifiers receive this value from their host.
export const REFERENCE_LEGACY_FIRST_SUBSCRIPTION_PERCENT = 44.404;

export const { evaluateOrderTotalDiscounts } = createQuotePromoDiscounts({
  promotionCustomerSemantic: (promotion) => promotionCustomerSemantic(
    promotion,
    REFERENCE_LEGACY_FIRST_SUBSCRIPTION_PERCENT,
  ),
});
