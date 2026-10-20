import { createQuotePromotionCodeAdjustments } from "@openlup/platform/promotions";
import { MINIMUM_PRODUCT_PAYABLE_MINOR } from "./promotionCodePreview.js";
export type { ApplyPromotionCodesV2Input } from "@openlup/platform/promotions";
export const { applyPromotionCodesV2, mapEngineRejectionReason } = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR });
