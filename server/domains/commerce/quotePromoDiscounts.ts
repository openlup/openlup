import { createQuotePromoDiscounts } from "@openlup/platform/promotions";
import { promotionCustomerSemantic } from "./promotionCustomerSemantic.js";
export type { QuoteDiscountResult } from "@openlup/platform/promotions";
export const { evaluateOrderTotalDiscounts } = createQuotePromoDiscounts({ promotionCustomerSemantic });
