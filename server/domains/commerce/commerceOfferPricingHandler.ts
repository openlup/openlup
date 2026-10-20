import { createCommerceOfferPricingHandler as createHandler } from "@openlup/platform/pricing";
import { bffResponder } from "../../_lib/bff/response.js";
import { commerceOfferPricingResponseSchema, type CommerceOfferPricingResponse } from "../../../src/domains/commerce/offerPricingContracts.js";
import type { PricingPolicyRequest, PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
export { COMMERCE_OFFER_PRICING_CACHE_CONTROL, COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL, OFFER_POLICY_CAPABILITY_HEADER, OFFER_POLICY_TOKEN_HEADER, OFFER_POLICY_VISITOR_HEADER } from "@openlup/platform/pricing";
export interface CommerceOfferPricingHandlerDeps {
  readOfferPricing(pricingPolicy?: PricingPolicySnapshot): Promise<CommerceOfferPricingResponse>;
  requirePricingPolicy?: boolean;
  resolvePricingPolicy?(request: {
    visitorId: string;
    pricingPolicy: PricingPolicyRequest;
  }): PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
}
export function createCommerceOfferPricingHandler(deps: CommerceOfferPricingHandlerDeps) {
  return createHandler({ ...deps, responder: bffResponder, commerceOfferPricingResponseSchema });
}
