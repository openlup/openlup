import { BffClientError } from "@/lib/bff/client";

/**
 * The server rejects a submit with CONFLICT / `provider_attempt_in_flight` when a
 * payment attempt row for this order is still open — e.g. the buyer taps "order"
 * again while a charge is processing.
 *
 * With the journey-stable idempotency key the order already exists, so this is NOT a
 * reason to mint a second order, rotate the key, or auto-retry (any of which risks a
 * duplicate charge). The buyer gets a distinct state rather than another checkout
 * submit; a retained continuation marker is the only safe status/readback seam.
 *
 * ⛔ The message must NOT claim a payment is under way. An open attempt row is not
 * proof of a charge: the admission gate is fail-closed for EVERY non-terminal
 * attempt status, so an intent that was created and never confirmed refuses a
 * re-submit exactly as a live charge does — whatever that row happens to call
 * itself. In the 2026-08-27 checkout dead end every such conflict was one of
 * those, with no issuer ever asked. So the copy says only what is true: this
 * journey cannot start another payment, and the existing order/payment must be
 * checked before any further buyer action.
 */
export function isProviderAttemptInFlightError(error: unknown): boolean {
  if (!(error instanceof BffClientError)) return false;
  if (error.code !== "CONFLICT") return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "provider_attempt_in_flight"
  );
}
