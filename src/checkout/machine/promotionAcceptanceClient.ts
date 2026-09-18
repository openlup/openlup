import type {
  PublicCreateQuoteRequest,
  CreateQuoteResponse,
} from "@/domains/commerce/contracts";
import { requestCacheKey } from "./commerceRequestCache";

type CommerceQuote = CreateQuoteResponse["quote"] & { promotionAcceptanceToken?: string };

export function semanticQuoteRequestKey(request: PublicCreateQuoteRequest): string {
  const { promotionAcceptanceToken: _token, ...semanticRequest } = request;
  return requestCacheKey(semanticRequest);
}

export function missingRequiredPromotionAcceptance(quote: CommerceQuote): boolean {
  return quote.discounts.some((discount) =>
    discount.promotionEngineVersion === "promotion-engine.v2" &&
    discount.reasonCode === "promotion_code_v2") && !quote.promotionAcceptanceToken;
}
