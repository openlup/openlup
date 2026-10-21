import type { ShippingTerms } from "../shipping/index.js";
import type { ResolvedAcquisitionTerms } from "./contracts/acquisitionTerms.js";
import type { CreateQuoteRequest } from "./contracts/quote.js";
import type { CreateQuoteOptions } from "./quotePorts.js";
import type { QuotePromotionResult } from "./dbBackedCommerceQuotePort.js";

export interface QuoteShippingPromotionInput<Request extends CreateQuoteRequest> {
  request: Request;
  options?: CreateQuoteOptions;
  regionCode: string;
  currency: string;
  referenceProductMinor: number;
  subtotalGrossMinor: number;
  atTime: string;
}
export interface QuoteShippingPromotionResult extends QuotePromotionResult {
  shippingGrossMinor: number;
  hasShipping: boolean;
  shippingTerms?: ShippingTerms;
  acquisitionTerms?: ResolvedAcquisitionTerms;
}
