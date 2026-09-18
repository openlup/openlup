import { BffClientError } from "@/lib/bff/client";

/**
 * True when the checkout endpoint reported itself disabled / not configured —
 * i.e. the hidden state: feature flag OFF, a dependency flag OFF, or missing
 * service env. This is a distinct, recognizable "checkout is off" classification
 * (as opposed to a generic transport/validation error).
 *
 * Both callers — the card/BLIK "Place order" submit (`useConfiguratorCheckout`)
 * and the Express Checkout wallet path — now surface an in-place error for this
 * state rather than bouncing to thank-you: a thank-you page implies an order
 * exists, and none does when checkout is disabled (parity with the null-intent
 * handling; see PR 2056 for the wallet path).
 */
export function isCheckoutDisabled(err: unknown): boolean {
  if (!(err instanceof BffClientError)) return false;
  if (err.code !== "UPSTREAM_UNAVAILABLE") return false;
  const details = err.details as
    | { reason?: string; requiredEnv?: string }
    | null
    | undefined;
  return (
    details?.reason === "feature_flag_disabled" ||
    details?.reason === "dependency_flag_disabled" ||
    details?.reason === "rehearsal_payment_disabled" ||
    Boolean(details?.requiredEnv)
  );
}
