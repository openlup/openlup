import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestration.js";

// Classifiers for the conflict outcomes the checkout orchestration can throw at the
// `start_runtime` stage. Extracted from the handler so the money-path handler stays
// within the source-size budget; behaviour is unchanged (pure predicates).

export function isStockUnavailableCheckoutConflict(error: unknown): boolean {
  return (
    error instanceof CheckoutOrchestrationError &&
    error.message === "start_runtime: Inventory reservation conflict"
  );
}

export function isProviderAttemptInFlightCheckoutConflict(error: unknown): boolean {
  return (
    error instanceof CheckoutOrchestrationError &&
    error.reason === "provider_attempt_in_flight"
  );
}

export function isJourneyConsumedCheckoutConflict(error: unknown): boolean {
  return (
    error instanceof CheckoutOrchestrationError &&
    error.reason === "journey_consumed"
  );
}

/**
 * `start_runtime` conflicts that map to an identical `CONFLICT + reason` response with
 * no compensation side effect — the FE resumes/handles each by its `reason`. Order is
 * significant and preserved from the original inline branches. Stock-unavailable is
 * intentionally NOT here: it additionally cancels the abandoned order, so the handler
 * keeps that branch inline.
 */
export const START_RUNTIME_SIMPLE_CONFLICTS: ReadonlyArray<{
  match: (error: unknown) => boolean;
  message: string;
  reason: string;
}> = [
  {
    match: isProviderAttemptInFlightCheckoutConflict,
    message: "Checkout payment already in flight",
    reason: "provider_attempt_in_flight",
  },
];
