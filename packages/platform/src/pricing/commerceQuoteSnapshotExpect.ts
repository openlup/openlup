import type { z } from "zod";
import {
  CommerceQuoteError,
  CommerceQuoteSnapshotError,
  type CommerceQuotePort,
} from "./quotePorts.js";

// Shared by the static and DB-backed quote snapshot verifiers. The verify body
// and request builder differ per verifier; only this re-quote-and-wrap tail is
// identical apart from two human-facing message strings, which are passed in so
// each verifier keeps its exact wording (asserted by their tests).
export interface QuoteSnapshotExpectMessages {
  /** Thrown when the re-quoted response fails schema validation. */
  invalidResponseMessage: string;
  /** Thrown when re-quoting raises a CommerceQuoteError (pricing changed). */
  catalogMismatchMessage: string;
}

export async function createExpectedQuote<Request, Response>(
  quotePort: CommerceQuotePort<Request, Response>,
  request: Request,
  messages: QuoteSnapshotExpectMessages,
  createQuoteResponseSchema: z.ZodType<Response>,
): Promise<Response> {
  try {
    const expected = await quotePort.createQuote(request);
    const parsed = createQuoteResponseSchema.safeParse(expected);
    if (!parsed.success) {
      throw new CommerceQuoteSnapshotError(
        "QUOTE_SNAPSHOT_MISMATCH",
        messages.invalidResponseMessage,
        { reason: "invalid_expected_quote" },
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof CommerceQuoteSnapshotError) throw error;
    if (error instanceof CommerceQuoteError) {
      throw new CommerceQuoteSnapshotError("QUOTE_SNAPSHOT_MISMATCH", messages.catalogMismatchMessage, {
        reason: error.code,
        ...error.details,
      });
    }

    throw error;
  }
}
