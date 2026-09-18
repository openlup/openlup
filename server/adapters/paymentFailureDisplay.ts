import {
  type PaymentFailureDisplayReason,
} from "../../src/domains/commerce/paymentFailureDisplayContracts.js";

/**
 * Read-time projection of a recorded failure reason into supported display copy.
 * Each mapping must follow the reason's producer; a status alone does not prove
 * an issuer decision. This changes no durable payment facts or retry policy.
 * Unknown or ambiguous reasons remain null and use generic copy.
 */
const DISPLAY_REASON_TABLE: Readonly<Record<string, PaymentFailureDisplayReason>> = Object.freeze({
  // Existing synchronous-decline identities from finalizeDeclinedAttempt.
  blik_recurring_unsupported_bank: "blik_recurring_unsupported_bank",
  provider_declined: "provider_declined",
  /**
   * Written when a reservation window elapsed before the payment settled. The
   * `expired` copy says the session ran out and starting again is enough, which
   * is the truth of it.
   */
  reservation_window_elapsed: "expired",
});

/**
 * The one row that is a pattern rather than a key, and why that is not the
 * shape-matching this file otherwise forbids.
 *
 * It is anchored to a single producer's exact template:
 * `tpayPaymentReconciliationProvider` builds `tpay_decline_${refusal.code}` and
 * is the only writer of this family. So the pattern is not a guess about strings
 * that look similar - it is that producer's construction, read back. Every value
 * it can emit means the same thing: the operator refused and reported a numbered
 * code, which is exactly what `provider_declined` copy says without claiming to
 * know which code. The specific code stays in `failureReason` for logs and
 * evidence.
 *
 * Enumerating the codes instead would put a second copy of a vendor's code list
 * here, next to the adapter that already owns it, and would silently stop
 * covering a code the provider adds. `paymentFailureDisplay.test.ts` pins the
 * template against a value production has actually produced, so a producer that
 * changes its construction fails here rather than going quiet.
 */
const NUMBERED_DECLINE = /^tpay_decline_\d+$/;

/**
 * Codes this repository has SEEN and deliberately does not map.
 *
 * `provider_webhook_failed` records a received payment.failed event. It does not
 * identify the refusal's cause or prove a wallet error. Likewise, the generic
 * intent status below can describe an unconfirmed intent with no issuer attempt.
 */
export const KNOWN_UNMAPPED_FAILURE_REASONS: readonly string[] = Object.freeze([
  "provider_webhook_failed",
  "stripe_requires_payment_method",
]);

/**
 * The bucket for one refusal, or `null` when this deployment cannot say.
 *
 * `null` is a real answer: it routes the buyer to the generic page, which is
 * where an unrecognised refusal belongs. Own-property lookup, so an inherited
 * key (`constructor`, `toString`) is not a mapping.
 */
export function displayReasonFor(failureReason: string | null | undefined): PaymentFailureDisplayReason | null {
  if (typeof failureReason !== "string") return null;
  const reason = failureReason.trim();
  if (!reason) return null;
  if (Object.prototype.hasOwnProperty.call(DISPLAY_REASON_TABLE, reason)) return DISPLAY_REASON_TABLE[reason]!;
  if (NUMBERED_DECLINE.test(reason)) return "provider_declined";
  return null;
}
