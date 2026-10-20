import { createExpectedQuote as expectQuote, createDbBackedCommerceQuoteSnapshotVerifier as createVerifier, type QuoteSnapshotExpectMessages } from "../../src/pricing/index.js";
import { createQuoteResponseSchema, type CreateQuoteRequest, type CreateQuoteResponse, type CommerceQuotePort } from "./quoteSchemaFixtures.js";
export function createExpectedQuote(quotePort: CommerceQuotePort, request: CreateQuoteRequest, messages: QuoteSnapshotExpectMessages) {
  return expectQuote(quotePort, request, messages, createQuoteResponseSchema);
}
export function createDbBackedCommerceQuoteSnapshotVerifier(quotePort: CommerceQuotePort) {
  return createVerifier(quotePort, quoteRequestFromSnapshot, createQuoteResponseSchema);
}
function quoteRequestFromSnapshot(snapshot: CreateQuoteResponse): CreateQuoteRequest {
  const context = snapshot.quote.context;
  return {
    mode: context?.mode ?? "one_time",
    lines: snapshot.quote.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      modeAtLine: context?.mode,
    })),
    sizeConstraint: context?.sizeConstraint,
    cadenceDays: context?.cadenceDays,
    promoCodes: context?.promoCodes ?? [],
    petId: context?.petId,
    petProfileContext: context?.petProfileContext,
  };
}
