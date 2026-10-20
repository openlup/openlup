import { createExpectedQuote as expectQuote } from "@openlup/platform/pricing";
import type { QuoteSnapshotExpectMessages } from "@openlup/platform/pricing";
import { createQuoteResponseSchema, type CreateQuoteRequest, type CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort } from "../../../src/domains/commerce/ports.js";
export type { QuoteSnapshotExpectMessages } from "@openlup/platform/pricing";
export function createExpectedQuote(quotePort: CommerceQuotePort, request: CreateQuoteRequest, messages: QuoteSnapshotExpectMessages): Promise<CreateQuoteResponse> {
  return expectQuote(quotePort, request, messages, createQuoteResponseSchema);
}
