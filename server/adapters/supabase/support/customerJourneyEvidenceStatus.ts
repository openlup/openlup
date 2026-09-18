import type { Row } from "../../../domains/support/customerJourneyCommon.js";

export type CustomerJourneyEvidenceSource =
  | "checkout_outbox"
  | "checkout_recovery_tokens"
  | "payment_provider_refs"
  | "subscription_communications"
  | "subscription_cycles"
  | "subscription_list"
  | "subscription_payment_methods"
  | "subscription_renewal_orders";

export type CustomerJourneyEvidenceRead<T> = {
  value: T[];
  state: "observed" | "observed_empty" | "unavailable" | "windowed";
  warning: string | null;
};

/**
 * Keeps an unavailable ancillary read distinct from an observed empty result.
 * The warning vocabulary is intentionally source-only: query errors and lookup
 * input may contain private data and must never reach a support response.
 */
export async function readCustomerJourneyEvidence<T extends Row>(
  source: CustomerJourneyEvidenceSource,
  query: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  windowSize?: number,
): Promise<CustomerJourneyEvidenceRead<T>> {
  try {
    const result = await query;
    if (result.error || !Array.isArray(result.data)) return unavailable(source);
    const value = result.data as T[];
    if (windowSize !== undefined && value.length >= windowSize) {
      return { value, state: "windowed", warning: `evidence_window_limited:${source}` };
    }
    return { value, state: value.length ? "observed" : "observed_empty", warning: null };
  } catch {
    return unavailable(source);
  }
}

function unavailable<T>(source: CustomerJourneyEvidenceSource): CustomerJourneyEvidenceRead<T> {
  return { value: [], state: "unavailable", warning: `evidence_unavailable:${source}` };
}

export function evidenceWarnings(...reads: Array<CustomerJourneyEvidenceRead<unknown>>): string[] {
  return reads.flatMap((read) => read.warning ? [read.warning] : []);
}
