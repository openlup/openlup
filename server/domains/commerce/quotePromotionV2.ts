import { createQuotePromotionV2 } from "@openlup/platform/promotions";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";
import { evaluateOrderTotalDiscounts, REFERENCE_LEGACY_FIRST_SUBSCRIPTION_PERCENT } from "./quotePromoDiscounts.js";
export const { evaluateAutomaticPromotionV2, legacyPromotionDataPort } = createQuotePromotionV2({
  promotionCustomerSemantic: (promotion) => promotionCustomerSemantic(
    promotion,
    REFERENCE_LEGACY_FIRST_SUBSCRIPTION_PERCENT,
  ),
  minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR,
  evaluateOrderTotalDiscounts,
});
