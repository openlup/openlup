import { classifyPaymentFailure, type PaymentExecutionProviderDecline, type PaymentFailureClassification, type PaymentFailureHint } from "@openlup/core/payment";
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
