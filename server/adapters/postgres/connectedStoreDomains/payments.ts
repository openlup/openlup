export const paymentsDomain = {
  owned: {
    // Private companion rows of the compatible payment_truth_events above.
    all: [
      "payment_simulator_attempts",
      "payment_simulator_observations",
      "payment_provider_states",
      "payment_provider_attempts",
      "payment_provider_attempt_evidence",
      "payment_provider_receipts",
      "payment_provider_transitions",
      "payment_method_refs",
      "payment_method_ref_receipts",
      "payment_method_recovery_authorities",
      "payment_provider_reconciliation_runs",
      "payment_prepared_absence_reopens",
      "payment_dunning_case_attribution",
      "payment_refund_evidence",
    ],
  },
  restore: {
    methodRefs: [
      "payment_method_refs",
      "payment_method_ref_receipts",
    ],
    simulatorProviderAndTruth: [
      "payment_simulator_attempts",
      "payment_simulator_observations",
      "payment_provider_states",
      "payment_provider_attempts",
      "payment_provider_attempt_evidence",
      "payment_provider_receipts",
      "payment_provider_transitions",
      "payment_truth_events",
      "payment_truth_reconciliation_evidence",
    ],
    recoveryAuthorities: [
      "payment_method_recovery_authorities",
    ],
    reconciliationAndEvidence: [
      "payment_provider_reconciliation_runs",
      "payment_prepared_absence_reopens",
      "payment_dunning_case_attribution",
      "payment_refund_evidence",
    ],
  },
  allowedInsertTriggers: {},
} as const;
