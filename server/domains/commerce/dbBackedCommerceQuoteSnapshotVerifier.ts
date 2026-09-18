import { isDeepStrictEqual } from "node:util";
import {
  type CreateQuoteRequest,
  type CreateQuoteResponse,
} from "../../../src/domains/commerce/contracts.js";
import {
  CommerceQuoteSnapshotError,
  type CommerceQuotePort,
  type CommerceQuoteSnapshotVerifierPort,
} from "../../../src/domains/commerce/ports.js";
import { projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";
import { createExpectedQuote } from "./commerceQuoteSnapshotExpect.js";

export function createDbBackedCommerceQuoteSnapshotVerifier(
  quotePort: CommerceQuotePort,
): CommerceQuoteSnapshotVerifierPort {
  async function verifyAndEnrich(snapshot: CreateQuoteResponse): Promise<CreateQuoteResponse> {
    const publicSnapshot = projectPublicQuoteSnapshot(snapshot);
    const expected = await createExpectedQuote(
      quotePort.createServerAuthoritativeQuote
        ? { createQuote: quotePort.createServerAuthoritativeQuote.bind(quotePort) }
        : quotePort,
      quoteRequestFromSnapshot(publicSnapshot),
      {
        invalidResponseMessage: "Commerce DB-backed quote verifier returned invalid response",
        catalogMismatchMessage:
          "Commerce quote snapshot does not match current DB-backed catalog pricing",
      },
    );
    if (!isDeepStrictEqual(publicSnapshot, projectPublicQuoteSnapshot(expected))) {
      throw new CommerceQuoteSnapshotError(
        "QUOTE_SNAPSHOT_MISMATCH",
        "Commerce quote snapshot does not match current DB-backed catalog pricing",
        {
          reason: "snapshot_does_not_match_db_backed_quote",
          skus: publicSnapshot.quote.lines.map((line) => line.sku),
        },
      );
    }
    return expected;
  }

  return {
    verifyQuoteSnapshot: verifyAndEnrich,
  };
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
