import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  type CreateQuoteResponse,
} from "./contracts/quote.js";
import {
  CommerceQuoteSnapshotError,
  type CommerceQuotePort,
  type CommerceQuoteSnapshotVerifierPort,
} from "./quotePorts.js";
import { projectPublicQuoteSnapshot } from "./catalogFactsProvenance.js";
import { createExpectedQuote } from "./commerceQuoteSnapshotExpect.js";

export function createDbBackedCommerceQuoteSnapshotVerifier<Request, Response extends CreateQuoteResponse>(
  quotePort: CommerceQuotePort<Request, Response>,
  quoteRequestFromSnapshot: (snapshot: Response) => Request,
  createQuoteResponseSchema: z.ZodType<Response>,
): CommerceQuoteSnapshotVerifierPort<Response> {
  async function verifyAndEnrich(snapshot: Response): Promise<Response> {
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
      createQuoteResponseSchema,
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
