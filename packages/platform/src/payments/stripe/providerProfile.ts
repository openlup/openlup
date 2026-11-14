import type { PaymentProviderProfile } from "../contracts/providerProfile.js";

/** Native policy declaration; the adapter still owns protocol translation. */
export const stripePaymentProviderProfile: Readonly<PaymentProviderProfile & { provider: "stripe" }> = Object.freeze({
  provider: "stripe", initial_flow: "one_time_payment", one_time_flow: "one_time_payment",
  requires_attempt_truth: true, readback_reference_order: "attempt-intent-session",
  claim_stale: true, claim_prepared: true, refund_kind: "cumulative-snapshot", refund_event_type: "charge.refunded",
  refund_operation_path: Object.freeze(["stripeRefundSnapshot", "chargeId"]),
  refund_amount_path: Object.freeze(["stripeRefundSnapshot", "amountRefundedMinor"]),
  refund_event_money_original: true, refund_full_evidence: true, refund_status_match: true, refund_ignore_old: true,
  refund_ignored_kind: "ignored_stripe_refund_snapshot", renewal_absence: true, interactive: false,
  trusted_oauth_codes: Object.freeze([]), trusted_dispatch_codes: Object.freeze([]), trusted_refusal_code: null,
});
