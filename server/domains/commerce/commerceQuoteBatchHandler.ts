import { createCommerceQuoteBatchHandler as createHandler } from "@openlup/platform/pricing";
import { bffResponder } from "../../_lib/bff/response.js";
import { createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema, type CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
import type { PricingPolicySnapshot } from "../../../src/domains/commerce/offerPolicyContracts.js";
export interface CommerceQuoteBatchHandlerDeps {
  quotePort: CommerceQuotePort;
  resolveCustomerEligibility?: (
    request: CreateQuoteRequest,
  ) => Promise<{ clientId: string | null; source: "anonymous" | "resolved_client" }>;
  resolvePricingPolicy?: (
    request: CreateQuoteRequest,
  ) => PricingPolicySnapshot | undefined | Promise<PricingPolicySnapshot | undefined>;
}
export function createCommerceQuoteBatchHandler(deps: CommerceQuoteBatchHandlerDeps) {
  return createHandler({ ...deps, responder: bffResponder, createQuoteBatchRequestSchema, publicCreateQuoteBatchResponseSchema });
}
