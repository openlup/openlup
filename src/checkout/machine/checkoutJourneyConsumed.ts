import { BffClientError } from "@/lib/bff/client";
import type { CheckoutRequest } from "@/domains/commerce/checkoutContracts";
import type { ConfiguratorIntent } from "@/domains/commerce/configuratorIntentContracts";
import type { CheckoutQuoteExpectation } from "@/checkout/composer/configuratorFormStore";
import {
  clearCheckoutAttemptKey,
  getOrCreateCheckoutAttemptKey,
} from "./checkoutAttemptStore";

/**
 * The server rejects a submit with CONFLICT / `journey_consumed` when the
 * journey-stable idempotency key already finalized an order — typically one
 * completed out-of-band (checkout recovery link) so the configurator never
 * cleared its stored attempt key. A retry under the same key can never
 * succeed; the caller must rotate the key and retry once.
 */
/**
 * Rotate the consumed journey key and rebuild the submit request under a
 * fresh identity: new key, first payment attempt (the stale sequence is
 * dropped). The server already cancelled the abandoned draft.
 */
export function rotateConsumedJourneyRequest(
  candidateIntent: ConfiguratorIntent,
  expectation: CheckoutQuoteExpectation | null | undefined,
  checkoutRequest: CheckoutRequest,
): CheckoutRequest {
  clearCheckoutAttemptKey();
  const rotatedIntent = {
    ...candidateIntent,
    idempotencyKey: getOrCreateCheckoutAttemptKey(candidateIntent, expectation),
  };
  const { paymentAttemptSequence: _staleAttempt, ...restRequest } = checkoutRequest;
  return { ...restRequest, intent: rotatedIntent };
}

export function isJourneyConsumedCheckoutError(error: unknown): boolean {
  if (!(error instanceof BffClientError)) return false;
  if (error.code !== "CONFLICT") return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "journey_consumed"
  );
}
