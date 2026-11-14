/** Closed native policy data. Evidence paths and codes are opaque compatibility values. */
export interface PaymentProviderProfile {
  readonly provider: string;
  readonly initial_flow: string | null;
  readonly one_time_flow: string | null;
  readonly requires_attempt_truth: boolean;
  readonly readback_reference_order: "attempt-intent-session" | "session-attempt-intent";
  readonly claim_stale: boolean;
  readonly claim_prepared: boolean;
  readonly refund_kind: "cumulative-snapshot" | "event-delta";
  readonly refund_event_type: string | null;
  readonly refund_operation_path: readonly string[] | null;
  readonly refund_amount_path: readonly string[] | null;
  readonly refund_event_money_original: boolean;
  readonly refund_full_evidence: boolean;
  readonly refund_status_match: boolean;
  readonly refund_ignore_old: boolean;
  readonly refund_ignored_kind: string | null;
  readonly renewal_absence: boolean;
  readonly interactive: boolean;
  readonly trusted_oauth_codes: readonly string[];
  readonly trusted_dispatch_codes: readonly string[];
  readonly trusted_refusal_code: string | null;
}
