/**
 * Canonical names for the effect-detection signals referenced by the per-job
 * reliability contracts in adopter-owned scheduler configuration (see
 * docs/platform/RUNTIME_AND_SELF_HOSTING.md). Adopters SHOULD add a conformance test that
 * cross-checks every declared signal against this set, so renaming a dedupe
 * key in an evaluator without updating the contract fails CI instead of
 * silently orphaning the contract.
 *
 * Entries are either platform_alerts dedupe keys (or their per-job prefixes,
 * e.g. `job_missed` for `job_missed:<jobName>`) or bespoke ledger names for
 * `no_ledger_exception` jobs.
 */
export const KNOWN_RELIABILITY_SIGNALS = [
  // Generic job-health detectors (observabilityEvaluator.ts jobAlert reasons).
  "job_failed",
  "job_missed",
  "job_stuck_running",
  "job_never_succeeded",
  "job_ledger_missing",
  // Queue health.
  "queue_backlog",
  "critical_queue_failure",
  // Email / outbox.
  "expected_send_overdue",
  "email_webhook_gap",
  "email_health_route_breach",
  // Subscriptions.
  "subscription_cycle_due_without_order",
  "subscription_cycle_unattempted",
  "subscription_active_without_payment_method",
  "subscription_paid_renewal_without_fulfillment",
  "subscription_delivery_reminder_missing",
  "subscription_delivery_alignment_overdue",
  "subscription_pending_activation_overdue",
  "subscription_active_zero_lines",
  "subscription_method_health_unchargeable",
  "subscription_method_health_activation_gap",
  "subscription_method_health_activation_gap_overdue",
  // Dunning.
  "dunning_retry_overdue",
  "dunning_expired_notice_missing",
  "dunning_admin_alert_missing",
  "dunning_admin_alert_failed",
  "dunning_admin_alert_skipped",
  // Payments (gated kinds carry the payment_ prefix in their dedupe keys; the
  // contract references the evidence-kind names used by the evaluators).
  "prepared_without_provider_ack",
  "webhook_missing",
  "stuck_processing",
  "recovery_missing",
  "payment_attempt_stranded",
  // Flag-INDEPENDENT card dead-end detectors: unlike the gated kinds above,
  // these carry their full dedupe key here because no runtime flag can mute
  // them and a contract may reference them directly.
  "payment_abandoned_before_confirmation",
  "order_pending_payment_past_recovery_window",
  "canonical_order_money_settlement_overdue",
  // Inventory / reservations (flag-independent family).
  "checkout_reservation_leak",
  "subscription_retry_reservation_leak",
  "inventory_reserved_balance_drift",
  // Promotion-code capacity recovery.
  "stale_promotion_claim",
  // OmniPack.
  "omnipack_paid_order_missing_dispatch_ref",
  "omnipack_dispatch_missing_provider_order_id",
  "omnipack_dispatch_ref_stale",
  "omnipack_stock_sync_stale",
  "omnipack_inbound_quarantined",
  "omnipack_reconciliation_state_conflict",
  "omnipack_fulfillment_status_frozen",
  "omnipack_fulfillment_label_created_frozen",
  "shipment_handed_over_without_tracking_ref",
  "omnipack_fulfillment_provider_ahead",
  // Accounting.
  "accounting_shipped_without_invoice",
  "accounting_invoice_outbox_stale",
  "accounting_ksef_pending_stale",
  "accounting_correction_ksef_pending_stale",
  "invoice_issued_without_customer_delivery",
  // Customer-journey diagnostics retention.
  "customer_diagnostic_prune_stale",
  // Bespoke ledgers for no_ledger_exception jobs.
  "cleanup_runs_ledger",
  "staging_rollout_guard_workflow",
] as const;

export type ReliabilitySignal = (typeof KNOWN_RELIABILITY_SIGNALS)[number];
