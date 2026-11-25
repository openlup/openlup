export const communicationsDomain = {
  owned: {
    bindingsConsentsAndNative: [
      "communication_event_bindings",
      "communication_event_receipts",
      "communication_event_erasures",
      "communication_recipient_consents",
      "communication_native_sends",
      "communication_native_observations",
      "communication_native_sync_state",
    ],
    dormantOutbox: [
      "outbox_dormant_event_types",
    ],
    transactionalReceipts: [
      "transactional_delivery_receipts",
    ],
  },
  restore: {
    transactionalReceipts: [
      "transactional_delivery_receipts",
    ],
    outboxAndNative: [
      "outbox_events",
      "communication_event_bindings",
      "communication_event_receipts",
      "communication_event_erasures",
      "communication_native_sync_state",
      "outbox_dormant_event_types",
      "communication_recipient_consents",
      "communication_native_sends",
      "communication_native_observations",
    ],
  },
  allowedInsertTriggers: {
    outbox_events: ["channel_purchase_outbox_guard", "communication_event_source_guard"],
  },
} as const;
