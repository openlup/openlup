import type { PaymentProviderProfile } from "../contracts/providerProfile.js";

/** Native policy declaration; this does not supply a portable composition. */
export const tpayPaymentProviderProfile: Readonly<PaymentProviderProfile & { provider: "tpay" }> = Object.freeze({
  provider: "tpay", initial_flow: "blik_recurring_activation", one_time_flow: "blik_one_time",
  requires_attempt_truth: true, readback_reference_order: "session-attempt-intent",
  claim_stale: true, claim_prepared: true, refund_kind: "event-delta", refund_event_type: null,
  refund_operation_path: null, refund_amount_path: null,
  refund_event_money_original: false, refund_full_evidence: false, refund_status_match: false, refund_ignore_old: false,
  refund_ignored_kind: null, renewal_absence: true, interactive: true,
  trusted_oauth_codes: Object.freeze(["tpay_oauth_failed", "tpay_oauth_timeout", "tpay_oauth_invalid_response"]),
  trusted_dispatch_codes: Object.freeze(["tpay_request_encode_failed", "tpay_request_deadline_exhausted"]),
  trusted_refusal_code: "tpay_request_refused",
});
