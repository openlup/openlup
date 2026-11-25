import {
  submitCheckout,
} from "@/domains/commerce/commerceClient";
import type {
  CheckoutRequest,
  CheckoutResponse,
} from "@/domains/commerce/checkoutContracts";
import type { BffRequestOptions } from "@/lib/bff/client";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import {
  recoverAmbiguousSubmit,
  toCommandKey,
  type AmbiguousSubmitRecovery,
  type ClientEventReporter,
  type SubmitFailureClass,
  type SubmitTransportBinding,
} from "@openlup/platform/storefront";

import { isProviderAttemptInFlightError } from "./checkoutProviderInFlight";
import { isCheckoutTimeoutError } from "./checkoutTimeout";

export type AmbiguousCheckoutRecovery = AmbiguousSubmitRecovery<CheckoutResponse>;

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
  // The one safe idempotent readback can itself observe the preserved
  // post-dispatch attempt. Keep that typed result so the caller retains the
  // established wait/recovery UX rather than flattening it to "unknown".
  return recoverAmbiguousSubmit(
    {
      transport: checkoutSubmitTransport(),
      classifySubmitFailure: classifyCheckoutSubmitFailure,
      report: checkoutClientEventReporter(),
    },
    input,
  );
}

// The storefront entry's bindings over this module's submit, classifier and
// telemetry. Built per call so `submitCheckout` and the reporter are read when
// the function runs, never at module load.
function checkoutSubmitTransport(): SubmitTransportBinding<CheckoutRequest, BffRequestOptions | null, CheckoutResponse> {
  return {
    commandKey: (request) => {
      const idempotencyKey = request.intent?.idempotencyKey;
      return idempotencyKey === undefined ? undefined : toCommandKey(idempotencyKey);
    },
    replay: (request, options, deadlineMs) =>
      submitCheckout(request, {
        ...(options ?? {}),
        timeoutMs: deadlineMs,
      }),
  };
}

function checkoutClientEventReporter(): ClientEventReporter {
  return (event) => {
    if (event === "submit_refused_in_flight") reportCheckoutClientEvent("payment_form", "submit_rejected_conflict");
  };
}

function classifyCheckoutSubmitFailure(error: unknown): SubmitFailureClass {
  // Explicit transient timeout from requestBff.
  if (isCheckoutTimeoutError(error)) return "timeout";
  // A repeated tap while the same journey is already charging must be resolved by
  // readback/resume, never by rotating the attempt key.
  if (isProviderAttemptInFlightError(error)) return "attempt_in_flight";
  // Browser transport failures (lost response, offline blip, aborted socket) are
  // ambiguous: the server might have accepted and committed the checkout.
  if (error instanceof TypeError) return "transport_uncertain";
  return "other";
}
