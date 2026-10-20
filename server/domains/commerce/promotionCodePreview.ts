import { createPromotionCodePreview } from "@openlup/platform/promotions";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
export { PROMOTION_ENGINE_VERSION } from "@openlup/platform/promotions";
/**
 * The smallest amount a product line may be sold for, in minor units, for this
 * deployment. It used to be the literal `100`, written out again at three other
 * call sites — and `100` is not a floor, it is *one major unit* frozen at an
 * exponent of two. In a currency without hundredths the same literal is a
 * hundredfold overstatement of a customer-facing minimum. The settlement profile
 * derives it from the currency's own exponent instead, so a zero-exponent
 * deployment gets 1 and this one still gets 100.
 *
 * Read once at module evaluation, like the other settlement defaults on the
 * server: a misconfigured floor should stop the process, not the first customer.
 */
export const MINIMUM_PRODUCT_PAYABLE_MINOR =
  readSettlementProfile(process.env).minimumProductPayableMinor;

export const { generatePromotionCode, normalizePromotionCode, promotionPreviewProof, verifyPromotionPreviewProof, previewPromotionCode } = createPromotionCodePreview({ minimumProductPayableMinor: MINIMUM_PRODUCT_PAYABLE_MINOR });
