import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import {
  checkoutProviderAttemptFailure,
} from "./commerceProviderAttemptFailure.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import { messageOf } from "./commerceCheckoutOrchestrationHelpers.js";
import { PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT } from "../../shared/providerAttemptFailureDiagnostic.js";

/**
 * Applies the compensation-capability contract at the start-runtime boundary.
 * A provider dispatch that may have charged must never expose an order id to
 * generic compensation; a named consumed journey is instead a fresh draft that
 * should be cleaned up before the client rotates its browser key.
 */
export function mapStartRuntimeFailure(
  error: unknown,
  draftOrderId: string,
): CheckoutOrchestrationError {
  const providerAttemptFailure = checkoutProviderAttemptFailure(error);
  if (providerAttemptFailure) {
    // `executePreparedProviderAttempt` writes the payment-control attempt
    // before it calls the PSP. Once that dispatch throws, the PSP may still
    // have accepted the charge. Keep the finalized order, reservation and
    // provisional subscription intact until reconciliation establishes the
    // terminal result; a compensating release here could both oversell stock
    // and permit a second charge for the same journey.
    return providerAttemptFailure;
  }
  if (
    error instanceof CommerceRuntimeConflictError &&
    error.details.reason === PROVIDER_ATTEMPT_PREPARE_IDEMPOTENCY_CONFLICT
  ) {
    // D8 refused a changed request before a second PSP call. Keep the existing
    // prepared attempt and aggregate fenced until reconciliation resolves it.
    return new CheckoutOrchestrationError(
      "start_runtime: provider attempt remains in flight",
      null,
      "provider_attempt_in_flight",
    );
  }
  if (
    error instanceof CommerceRuntimeConflictError &&
    error.details.reason === "journey_consumed"
  ) {
    // The journey key already finalized an order; the fresh draft minted for
    // this submit is abandoned and needs compensation, and the client must
    // rotate its key before retrying.
    return new CheckoutOrchestrationError(
      messageOf(error, "start_runtime"),
      draftOrderId,
      "journey_consumed",
    );
  }
  return new CheckoutOrchestrationError(messageOf(error, "start_runtime"), draftOrderId);
}
