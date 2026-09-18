export const PSP_PROVIDER_KINDS = ["stripe", "tpay"] as const;
export type PspProviderKind = (typeof PSP_PROVIDER_KINDS)[number];

export const PSP_PAYMENT_SCENARIOS = [
  "stripe_one_time_card_wallet",
  "stripe_reusable_off_session",
  "tpay_one_time_blik",
  "tpay_blik_recurring",
] as const;
export type PspPaymentScenario = (typeof PSP_PAYMENT_SCENARIOS)[number];

export const ASYNC_CHECKOUT_STATUSES = [
  "pending_provider_action",
  "requires_action",
  "processing",
  "paid",
  "failed",
  "expired",
] as const;
export type AsyncCheckoutStatus = (typeof ASYNC_CHECKOUT_STATUSES)[number];

export const PSP_OBSERVABILITY_EVENTS = [
  "payment.checkout_started",
  "payment.provider_attempt_created",
  "payment.provider_action_returned",
  "payment.webhook_received",
  "payment.webhook_rejected",
  "payment.result_applied",
  "payment.reconciliation_mismatch",
  "payment.recovery_link_created",
  "payment.recovery_completed",
  "payment.stuck_processing_detected",
] as const;
export type PspObservabilityEvent = (typeof PSP_OBSERVABILITY_EVENTS)[number];

export const PSP_BRUTAL_CHALLENGE_CHECKS = [
  "double_charge",
  "lost_webhook",
  "provider_paid_local_unpaid",
  "local_paid_provider_unpaid",
  "stale_idempotency_key",
  "replayed_callback_or_webhook",
  "wrong_customer_session_or_token",
  "amount_or_currency_mismatch",
  "missing_recovery_path",
  "missing_operator_evidence",
  "hidden_live_flag_leakage",
  "secret_or_raw_payload_leakage",
] as const;
export type PspBrutalChallengeCheck = (typeof PSP_BRUTAL_CHALLENGE_CHECKS)[number];

export const PSP_ACCEPTANCE_GATES = [
  "local_intent_before_provider_payment",
  "deterministic_provider_idempotency",
  "browser_return_never_marks_paid",
  "verified_provider_result_before_fulfillment",
  "failed_renewal_has_recovery_path",
  "stuck_processing_has_watchdog_or_reconciliation",
  "no_sensitive_provider_payload_in_logs",
  "sandbox_e2e_before_public_launch",
] as const;
export type PspAcceptanceGate = (typeof PSP_ACCEPTANCE_GATES)[number];

export type PspIntegrationWaveId =
  | "wave_0_spec_risk_register"
  | "wave_1_async_checkout_contract"
  | "wave_2_provider_attempt_idempotency"
  | "wave_3_stripe_sandbox_adapter"
  | "wave_4_tpay_sandbox_adapter"
  | "wave_5_webhook_ingest_apply_result"
  | "wave_6_recovery_resume"
  | "wave_7_reconciliation_observability"
  | "wave_8_sandbox_e2e_signoff";

export interface PspProviderMatrixEntry {
  scenario: PspPaymentScenario;
  provider: PspProviderKind;
  localOwner: "payment-control";
  subscriptionOwner: "downstream-subscription-engine";
  providerRole: "payment-executor";
  requiredRefs: readonly string[];
  canonicalSuccessEvent: "payment.succeeded";
  canonicalFailureEvent: "payment.failed" | "payment.requires_action";
}

export const PSP_PROVIDER_MATRIX: readonly PspProviderMatrixEntry[] = [
  {
    scenario: "stripe_one_time_card_wallet",
    provider: "stripe",
    localOwner: "payment-control",
    subscriptionOwner: "downstream-subscription-engine",
    providerRole: "payment-executor",
    requiredRefs: ["payment_intent_id", "charge_id"],
    canonicalSuccessEvent: "payment.succeeded",
    canonicalFailureEvent: "payment.failed",
  },
  {
    scenario: "stripe_reusable_off_session",
    provider: "stripe",
    localOwner: "payment-control",
    subscriptionOwner: "downstream-subscription-engine",
    providerRole: "payment-executor",
    requiredRefs: ["customer_id", "setup_intent_id", "payment_method_id"],
    canonicalSuccessEvent: "payment.succeeded",
    canonicalFailureEvent: "payment.requires_action",
  },
  {
    scenario: "tpay_one_time_blik",
    provider: "tpay",
    localOwner: "payment-control",
    subscriptionOwner: "downstream-subscription-engine",
    providerRole: "payment-executor",
    requiredRefs: ["transaction_id", "transaction_title", "group_id"],
    canonicalSuccessEvent: "payment.succeeded",
    canonicalFailureEvent: "payment.failed",
  },
  {
    scenario: "tpay_blik_recurring",
    provider: "tpay",
    localOwner: "payment-control",
    subscriptionOwner: "downstream-subscription-engine",
    providerRole: "payment-executor",
    requiredRefs: ["payid_alias", "alias_status", "recurring_model"],
    canonicalSuccessEvent: "payment.succeeded",
    canonicalFailureEvent: "payment.failed",
  },
];

export interface PspIntegrationWave {
  id: PspIntegrationWaveId;
  title: string;
  mustHaveDetailedPlan: true;
  mustRunPreImplementationBrutalChallenge: true;
  mustRunPostImplementationBrutalReview: true;
  requiresDocsUpdate: true;
  requiredChallengeChecks: readonly PspBrutalChallengeCheck[];
  requiredObservabilityEvents: readonly PspObservabilityEvent[];
  requiredAcceptanceGates: readonly PspAcceptanceGate[];
}

export const PSP_INTEGRATION_WAVES: readonly PspIntegrationWave[] = [
  wave("wave_0_spec_risk_register", "PSP integration spec and risk register", [
    "payment.checkout_started",
  ], [
    "local_intent_before_provider_payment",
    "deterministic_provider_idempotency",
  ]),
  wave("wave_1_async_checkout_contract", "Async checkout contract", [
    "payment.checkout_started",
    "payment.provider_action_returned",
  ], [
    "browser_return_never_marks_paid",
    "sandbox_e2e_before_public_launch",
  ]),
  wave("wave_2_provider_attempt_idempotency", "Provider attempt idempotency", [
    "payment.provider_attempt_created",
  ], [
    "local_intent_before_provider_payment",
    "deterministic_provider_idempotency",
  ]),
  wave("wave_3_stripe_sandbox_adapter", "Stripe sandbox adapter", [
    "payment.provider_attempt_created",
    "payment.provider_action_returned",
    "payment.webhook_received",
  ], [
    "verified_provider_result_before_fulfillment",
    "failed_renewal_has_recovery_path",
  ]),
  wave("wave_4_tpay_sandbox_adapter", "Tpay sandbox adapter", [
    "payment.provider_attempt_created",
    "payment.provider_action_returned",
    "payment.webhook_received",
  ], [
    "verified_provider_result_before_fulfillment",
    "failed_renewal_has_recovery_path",
  ]),
  wave("wave_5_webhook_ingest_apply_result", "Webhook ingest and apply result", [
    "payment.webhook_received",
    "payment.webhook_rejected",
    "payment.result_applied",
  ], [
    "browser_return_never_marks_paid",
    "verified_provider_result_before_fulfillment",
  ]),
  wave("wave_6_recovery_resume", "Recovery and resume", [
    "payment.recovery_link_created",
    "payment.recovery_completed",
  ], [
    "failed_renewal_has_recovery_path",
  ]),
  wave("wave_7_reconciliation_observability", "Reconciliation and observability", [
    "payment.reconciliation_mismatch",
    "payment.stuck_processing_detected",
  ], [
    "stuck_processing_has_watchdog_or_reconciliation",
    "no_sensitive_provider_payload_in_logs",
  ]),
  wave("wave_8_sandbox_e2e_signoff", "Sandbox E2E sign-off", PSP_OBSERVABILITY_EVENTS, [
    "sandbox_e2e_before_public_launch",
  ]),
];

function wave(
  id: PspIntegrationWaveId,
  title: string,
  requiredObservabilityEvents: readonly PspObservabilityEvent[],
  requiredAcceptanceGates: readonly PspAcceptanceGate[],
): PspIntegrationWave {
  return {
    id,
    title,
    mustHaveDetailedPlan: true,
    mustRunPreImplementationBrutalChallenge: true,
    mustRunPostImplementationBrutalReview: true,
    requiresDocsUpdate: true,
    requiredChallengeChecks: PSP_BRUTAL_CHALLENGE_CHECKS,
    requiredObservabilityEvents,
    requiredAcceptanceGates,
  };
}
