import {
  submitCheckout,
} from "@/domains/commerce/commerceClient";
import type {
  CheckoutRequest,
  CheckoutResponse,
} from "@/domains/commerce/checkoutContracts";
import type { BffRequestOptions } from "@/lib/bff/client";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";

import { isProviderAttemptInFlightError } from "./checkoutProviderInFlight";
import { isCheckoutTimeoutError } from "./checkoutTimeout";

export type AmbiguousCheckoutRecovery =
  | { kind: "recovered"; response: CheckoutResponse }
  | { kind: "no_stable_identity" }
  | { kind: "in_flight" }
  | { kind: "unknown" };

/**
 * A checkout submit can be accepted server-side even when the browser never gets
 * the response (mobile timeout, tab/network drop, or an in-flight conflict from
 * a duplicated tap). In that state the stable journey idempotency key is the only
 * safe identity: never rotate it and never mint a second payment attempt.
 * Transport uncertainty gets one exact replay; an explicit in-flight refusal is
 * already authoritative and must never trigger another checkout POST.
 */
export async function recoverAmbiguousCheckoutSubmit(input: {
  error: unknown;
  request: CheckoutRequest | null;
  options: BffRequestOptions | null;
}): Promise<AmbiguousCheckoutRecovery | null> {
  if (!isAmbiguousCheckoutSubmitError(input.error)) return null;
  if (isProviderAttemptInFlightError(input.error)) {
    reportCheckoutClientEvent("payment_form", "submit_rejected_conflict");
    return { kind: "in_flight" };
  }
  const request = input.request;
  const idempotencyKey = request?.intent?.idempotencyKey;
  if (!request || !idempotencyKey) return { kind: "no_stable_identity" };

  try {
    const response = await submitCheckout(request, {
      ...(input.options ?? {}),
      timeoutMs: 10_000,
    });
    return { kind: "recovered", response };
  } catch (error) {
    // The one safe idempotent readback can itself observe the preserved
    // post-dispatch attempt. Keep that typed result so the caller retains the
    // established wait/recovery UX rather than flattening it to "unknown".
    if (isProviderAttemptInFlightError(error)) return { kind: "in_flight" };
    return { kind: "unknown" };
  }
}

function isAmbiguousCheckoutSubmitError(error: unknown): boolean {
  // Explicit transient timeout from requestBff.
  if (isCheckoutTimeoutError(error)) return true;
  // A repeated tap while the same journey is already charging must be resolved by
  // readback/resume, never by rotating the attempt key.
  if (isProviderAttemptInFlightError(error)) return true;
  // Browser transport failures (lost response, offline blip, aborted socket) are
  // ambiguous: the server might have accepted and committed the checkout.
  if (error instanceof TypeError) return true;
  return false;
}
