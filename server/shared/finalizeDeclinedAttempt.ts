import {
  classifyPaymentFailure,
  type PaymentExecutionProviderDecline,
  type PaymentFailureClassification,
  type PaymentFailureHint,
} from "@openlup/core/payment";

import type { PaymentControlRuntimePort } from "../../src/domains/commerce/runtimePorts.js";

/**
 * Stable failure reasons for a synchronous provider decline.
 *
 * These are codes, not messages: they are persisted to
 * `commerce_payment_attempts.failure_reason` and read back by the checkout UI to
 * choose what the buyer is told. Provider prose never becomes one — Tpay's
 * `errorMessage` is free-form Polish that can carry payer-identifying text.
 */
export const DECLINE_FAILURE_REASONS = {
  /** The payer's bank cannot register a reusable mandate — offer a card instead. */
  mandateUnsupported: "blik_recurring_unsupported_bank",
  /** Declined for a reason the provider did not distinguish. */
  generic: "provider_declined",
} as const;

/** Maps a provider refusal to the stable code persisted as `failure_reason`. */
export function declineFailureReason(decline: PaymentExecutionProviderDecline): string {
  return decline.mandateUnsupported
    ? DECLINE_FAILURE_REASONS.mandateUnsupported
    : DECLINE_FAILURE_REASONS.generic;
}

/**
 * The one place a refused payment gets a class, for every rail that consumes a
 * synchronous decline: interactive checkout, checkout recovery, and the
 * off-session renewal cron.
 *
 * Provider-agnostic on purpose. Every code the adapter understood has already
 * been translated into `adviceCode` and `neutralReasonHints` by the adapter that
 * owns the vocabulary, so nothing here needs to know which provider refused.
 *
 * The one reading this seam adds is the mandate flag. `mandateUnsupported` is a
 * neutral capability statement any adapter may set, and it is what produces the
 * scheme-named failure reason below; asserting the matching hint is what turns
 * that reason into `mandate_dead` instead of leaving it unclassified. Doing it
 * here rather than per adapter means a second adapter setting the same flag gets
 * the same class without repeating the mapping.
 *
 * DISPLAY-LOAD-BEARING, and NOT a cadence input. Three live readers turn the
 * class this seam decides into what the payer is told: `dunningFailureClassPort`
 * reads it off the case, `customerAccountActionRequiredReadModel` selects it into
 * the account surface, and `paymentRecoverySetupHandler` renders it as the cause
 * sentence on the recovery page. What still does NOT read it is the retry ladder:
 * no cadence, retry decision or scheduling branch consults the class, and that
 * wave stays gated on validating this taxonomy against the historical corpus.
 *
 * `failureReasonKey` overrides the reason this seam would derive itself, and is
 * supplied by a rail that persists a DIFFERENT reason string with the attempt:
 * the reconciliation rail writes its own adapter-prefixed key, not
 * `provider_declined`. That key is the classifier's weakest evidence tier, so
 * the override changes a class only where the rail's own key is mapped; what it
 * always changes is `decidedBy`, and that is the point. The historical-corpus
 * replay reproduces a verdict from the stored attempt row, so the key named in
 * the telemetry has to be the key actually on that row rather than one this seam
 * invented for itself.
 */
export function classifyDecline(
  decline: PaymentExecutionProviderDecline,
  options: { failureReasonKey?: string } = {},
): PaymentFailureClassification {
  const asserted: PaymentFailureHint[] = [...(decline.neutralReasonHints ?? [])];
  if (decline.mandateUnsupported) asserted.push("mandateUnsupported");
  return classifyPaymentFailure({
    adviceCode: decline.adviceCode,
    declineCode: decline.declineCode,
    neutralReasonHints: asserted,
    failureReasonKey: options.failureReasonKey ?? declineFailureReason(decline),
  });
}

/**
 * Closes an attempt the provider refused during execution.
 *
 * Execution adapters cannot report a terminal status themselves, so a decline
 * arrives as {@link PaymentExecutionProviderDecline} and the terminal transition
 * happens here. Skipping it would leave the attempt in `processing` forever for
 * providers that emit no failure callback.
 *
 * ⛔ Does NOT emit the `payment_decline_terminal` operational event, and must not
 * start. This is one of several producers of a terminal refusal — the recovery-pay
 * finalizer in `checkoutRecoveryPayService.ts` and the admin runtime handler
 * reach the same durable write without passing through here — so the signal is
 * emitted at the port adapter that performs the write, by
 * `server/shared/signalTerminalPaymentDecline.ts`. Emitting here as well would
 * double-report every interactive decline, and would still miss the others.
 */
export async function finalizeDeclinedAttempt(
  port: Pick<PaymentControlRuntimePort, "applyResult">,
  args: {
    idempotencyKey: string;
    orderId: string;
    paymentIntentId: string;
    /** Used only if the RPC echoes no attempt id of its own. */
    fallbackAttemptId: string;
    decline: PaymentExecutionProviderDecline;
    /**
     * Releases the order's stock holds. Supply it ONLY from a rail whose refusal
     * is genuinely terminal, because the RPC itself does not release: the
     * caller's own `applyPaymentResult` wrapper does.
     *
     * ⛔ The interactive checkout call site deliberately omits it, and that is
     * NOT an oversight — do not "fix" it. Every refusal reaching that site is a
     * `recoverable_decline`, whose order stays `pending_payment` and re-payable;
     * `commerceRuntimeService.ts:258-263` withholds the release for exactly that
     * reason ("releasing their stock here creates a paid-without-reservation
     * path on the next recovery attempt"), and
     * the pgTAP recoverable-decline scope proof pins the hold as retained.
     * Passing it there would break the retry it looks like it protects. The
     * parameter therefore has no production caller today.
     */
    releaseReservations?: (input: { idempotencyKey: string; orderId: string; reason: string }) => Promise<unknown>;
    now?: () => Date;
  },
): Promise<{ paymentAttemptId: string; status: "failed" }> {
  const {
    idempotencyKey, orderId, paymentIntentId, fallbackAttemptId, decline,
    releaseReservations, now = () => new Date(),
  } = args;
  const result = await port.applyResult({
    idempotencyKey,
    orderId,
    paymentIntentId,
    resultStatus: "failed",
    occurredAt: now().toISOString(),
    failureReason: declineFailureReason(decline),
    failureClassification: classifyDecline(decline),
  });
  if (releaseReservations) {
    await releaseReservations({
      idempotencyKey: `${idempotencyKey}:inventory-release`,
      orderId,
      reason: "payment_failed",
    });
  }
  return {
    paymentAttemptId: result.paymentAttemptId || fallbackAttemptId,
    status: "failed",
  };
}
