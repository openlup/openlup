import { createDbBackedCommerceQuoteSnapshotVerifier as createVerifier } from "@openlup/platform/pricing";
import { createQuoteResponseSchema, type CreateQuoteRequest, type CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CommerceQuotePort, CommerceQuoteSnapshotVerifierPort } from "../../../src/domains/commerce/ports.js";
export function createDbBackedCommerceQuoteSnapshotVerifier(quotePort: CommerceQuotePort): CommerceQuoteSnapshotVerifierPort {
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
