import { createCommerceQuoteHandler as createSingle, createCommerceQuoteBatchHandler as createBatch, createCommerceOfferPricingHandler as createOffer, type CommerceQuoteHandlerDeps, type CommerceQuoteBatchHandlerDeps, type CommerceOfferPricingHandlerDeps } from "../../src/pricing/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import { createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema, createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema, commerceOfferPricingResponseSchema, type CreateQuoteRequest, type CreateQuoteResponse, type CommerceOfferPricingResponse } from "./quoteSchemaFixtures.js";
export { COMMERCE_OFFER_PRICING_CACHE_CONTROL, COMMERCE_OFFER_PRICING_ASSIGNED_CACHE_CONTROL, OFFER_POLICY_CAPABILITY_HEADER, OFFER_POLICY_TOKEN_HEADER, OFFER_POLICY_VISITOR_HEADER } from "../../src/pricing/index.js";
const responder = createBffResponder();
export function createCommerceQuoteHandler(deps: Omit<CommerceQuoteHandlerDeps<CreateQuoteRequest, CreateQuoteResponse>, "responder" | "createQuoteRequestSchema" | "createQuoteResponseSchema" | "publicCreateQuoteRequestSchema" | "publicCreateQuoteResponseSchema">) {
  return createSingle({ ...deps, responder, createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema });
}
export function createCommerceQuoteBatchHandler(deps: Omit<CommerceQuoteBatchHandlerDeps<CreateQuoteRequest, CreateQuoteResponse>, "responder" | "createQuoteBatchRequestSchema" | "publicCreateQuoteBatchResponseSchema">) {
  return createBatch({ ...deps, responder, createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema });
}
export function createCommerceOfferPricingHandler(deps: Omit<CommerceOfferPricingHandlerDeps<CommerceOfferPricingResponse>, "responder" | "commerceOfferPricingResponseSchema">) {
  return createOffer({ ...deps, responder, commerceOfferPricingResponseSchema });
}
