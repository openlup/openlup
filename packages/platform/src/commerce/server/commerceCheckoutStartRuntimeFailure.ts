import { CommerceRuntimeConflictError } from "../runtimeErrors.js";
import { isInventoryAdmissionBusy } from "./checkoutConflictClassifiers.js";
import { messageOf } from "../checkoutHelpers.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
export function createCheckoutStartRuntimeFailure(bindings: {
  checkoutProviderAttemptFailure(error: unknown): CheckoutOrchestrationError | null;
  prepareConflictReason: string;
}) {

function mapStartRuntimeFailure(
  error: unknown,
  draftOrderId: string,
): CheckoutOrchestrationError {
  const providerAttemptFailure = bindings.checkoutProviderAttemptFailure(error);
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
    error.details.reason === bindings.prepareConflictReason
  ) {
    // D8 refused a changed request before a second PSP call. Keep the existing
    // prepared attempt and aggregate fenced until reconciliation resolves it.
    return new CheckoutOrchestrationError(
      "start_runtime: provider attempt remains in flight",
      null,
      "provider_attempt_in_flight",
    );
  }
  if (error instanceof CommerceRuntimeConflictError && error.details.reason === "acquisition_terms_changed") {
    return new CheckoutOrchestrationError("Acquisition terms changed", draftOrderId, "acquisition_terms_changed");
  }
  if (isInventoryAdmissionBusy(error)) {
    return new CheckoutOrchestrationError("Inventory admission temporarily unavailable", null, "inventory_admission_busy");
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

return { mapStartRuntimeFailure };
}
