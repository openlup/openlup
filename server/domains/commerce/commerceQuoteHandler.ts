import { createCommerceQuoteHandler as createHandler } from "@openlup/platform/pricing";
import { bffResponder } from "../../_lib/bff/response.js";
import { createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema, type CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
export interface CommerceQuoteHandlerDeps {
  quotePort: CommerceQuotePort;
  fallbackQuotePort?: CommerceQuotePort;
  resolveCustomerEligibility?: (
    request: CreateQuoteRequest,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
  createPromotionAcceptance?: (
    request: CreateQuoteRequest,
    quote: Awaited<ReturnType<CommerceQuotePort["createQuote"]>>["quote"],
  ) => string | null;
  honorPromotionAcceptance?: (
    token: string,
    request: CreateQuoteRequest,
    quote: Awaited<ReturnType<CommerceQuotePort["createQuote"]>>["quote"],
  ) => boolean;
}
export function createCommerceQuoteHandler(deps: CommerceQuoteHandlerDeps) {
  return createHandler({ ...deps, responder: bffResponder, createQuoteRequestSchema, createQuoteResponseSchema, publicCreateQuoteRequestSchema, publicCreateQuoteResponseSchema });
}
