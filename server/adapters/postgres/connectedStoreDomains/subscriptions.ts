export const subscriptionsDomain = {
  owned: {
    renewalOccurrences: [
      "subscription_cycle_occurrences",
      "subscription_cycle_generations",
    ],
    renewalCases: ["subscription_cycle_cases"],
    renewalPreparations: ["subscription_cycle_preparations"],
    cancelFeedback: [
      "subscription_cancel_feedback",
    ],
    dunningAndRetry: [
      "subscription_dunning_cases",
      "subscription_dunning_notifications",
      "subscription_retry_obligations",
      "subscription_retry_receipts",
      "subscription_retry_recovery_authorizations",
    ],
    stockWaitAndLifecycle: [
      "subscription_stock_wait_cases",
      "subscription_renewal_attachments",
      "subscription_method_state_events",
      "subscription_method_states",
      "subscription_activations",
    ],
    destinationSelections: [
      "subscription_destination_v2_selections",
    ],
    commandsQuotesAndSupport: [
      "subscription_command_receipts",
      "subscription_quote_previews",
      "subscription_edit_quotes",
      "customer_support_subscription_commands",
      "customer_support_subscription_audit_events",
    ],
    lines: [
      "subscription_lines",
    ],
    deliveryAlignmentAndProfiles: [
      "subscription_delivery_alignment_cases",
      "subscription_delivery_alignment_admission_receipts",
      "subscription_delivery_alignment_arrivals",
      "subscriber_profiles",
      "subscriber_review_access_grants",
      "subscriber_retention_intents",
    ],
    settings: [
      "subscriber_retention_activation_watermarks",
      "subscription_delivery_alignment_control",
    ],
    reminders: [
      "subscription_reminder_ledger",
    ],
    noticeRefusals: [
      "subscription_notice_refusals",
    ],
  },
  restore: {
    root: [
      "subscriptions",
    ],
    eventsQuotesAndTerms: [
      "subscription_events",
      "subscription_cancel_feedback",
      "subscription_command_receipts",
      "subscription_quote_previews",
      "subscription_edit_quotes",
      "subscription_pause_windows",
      "subscription_renewal_terms",
      "subscription_renewal_term_lines",
    ],
    methodStates: [
      "subscription_method_states",
    ],
    operationsLinesAndCycles: [
      "subscription_renewal_operations",
      "subscription_lines",
      "subscription_cycles",
    ],
    activationsAndMethodEvents: [
      "subscription_activations",
      "subscription_renewal_attachments",
      "subscription_method_state_events",
    ],
    reminders: [
      "subscription_reminder_ledger",
    ],
    noticeRefusals: [
      "subscription_notice_refusals",
    ],
    renewalOutcomes: [
      "subscription_renewal_outcomes",
    ],
    destinationSelections: [
      "subscription_destination_v2_selections",
    ],
    supportCommands: [
      "customer_support_subscription_commands",
      "customer_support_subscription_audit_events",
    ],
    deliveryAlignment: [
      "subscription_delivery_alignment_cases",
      "subscription_delivery_alignment_admission_receipts",
      "subscription_delivery_alignment_arrivals",
    ],
    dunning: [
      "subscription_dunning_cases",
      "subscription_dunning_notifications",
    ],
    retry: [
      "subscription_retry_obligations",
      "subscription_retry_receipts",
      "subscription_retry_recovery_authorizations",
    ],
    stockWaitAndProfiles: [
      "subscription_stock_wait_cases",
      "subscriber_profiles",
      "subscriber_review_access_grants",
      "subscriber_retention_intents",
    ],
  },
  settings: [
    "subscriber_retention_activation_watermarks",
    "subscription_delivery_alignment_control",
  ],
  allowedInsertTriggers: {
    subscription_cycles: ["trg_subscription_delivery_alignment_guard_cycle_insert", "subscriptions_guard_renewal_cycles"],
    // The guard admits only classic inserts. The binder acts only on opt-in
    // events, whose subscriptions are sized.v1 and refused before any writes.
    subscriptions: ["subscriptions_configured_offer_guard"],
    subscription_events: ["subscription_events_bind_sized_opt_in", "communication_subscription_subject", "subscription_events_catalog_final"],
    subscription_edit_quotes: ["subscription_edit_quotes_catalog_final"],
    subscription_quote_previews: ["subscription_quote_previews_catalog_final"],
    subscription_renewal_terms: ["subscription_renewal_terms_catalog_acceptance_admit"],
    subscription_renewal_operations: ["subscription_renewal_operations_catalog_acceptance_admit", "subscriptions_guard_renewal_operations"],
    subscription_stock_wait_cases: ["subscriptions_guard_renewal_stock_wait"],
  },
} as const;
