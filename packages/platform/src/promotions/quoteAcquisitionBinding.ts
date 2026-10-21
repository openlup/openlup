import type { PromotionRow } from "@openlup/core/promo";
import type { AcquisitionFinancialPolicy } from "../pricing/index.js";

export interface QuoteAcquisitionBinding<Request = unknown> {
  financialPolicy: AcquisitionFinancialPolicy<PromotionRow>;
  capability(request: Request): unknown;
}
