export const commerceDomain = {
  owned: {
    draftReceipts: [
      "commerce_order_draft_receipts",
    ],
    adjustments: [
      "commerce_order_adjustments",
    ],
    recoveryAndReminders: [
      "commerce_checkout_recovery_tokens",
      "commerce_reminder_episodes",
    ],
    destinations: [
      "commerce_destinations",
      "commerce_destination_bindings",
      "commerce_destination_v2_receipts",
      "commerce_destination_v2_documents",
      "commerce_destination_v2_checkout_selections",
      "commerce_destination_v2_order_bindings",
    ],
    operatorsHoldsAndCompensations: [
      "commerce_operators",
      "commerce_order_holds",
      "commerce_order_operations",
      "commerce_checkout_compensations",
    ],
    reviews: [
      "commerce_order_reviews",
      "commerce_order_review_media",
      "commerce_order_review_command_receipts",
      "commerce_order_review_audit",
    ],
  },
  restore: {
    operators: [
      "commerce_operators",
    ],
    orders: [
      "commerce_orders",
    ],
    orderItemsAndDraftReceipts: [
      "commerce_order_items",
      "commerce_order_draft_receipts",
    ],
    adjustments: [
      "commerce_order_adjustments",
    ],
    checkoutLedgerAndCompensations: [
      "commerce_checkout_attempt_ledger",
      "commerce_checkout_compensations",
    ],
    settlements: [
      "commerce_settlement_intents",
      "commerce_settlement_transitions",
    ],
    destinations: [
      "commerce_destinations",
      "commerce_destination_bindings",
      "commerce_destination_v2_receipts",
      "commerce_destination_v2_documents",
      "commerce_destination_v2_checkout_selections",
      "commerce_destination_v2_order_bindings",
    ],
    holdsAndOperations: [
      "commerce_order_holds",
      "commerce_order_operations",
    ],
    recoveryAndReminders: [
      "commerce_checkout_recovery_tokens",
      "commerce_reminder_episodes",
    ],
    reviews: [
      "commerce_order_reviews",
      "commerce_order_review_media",
      "commerce_order_review_command_receipts",
      "commerce_order_review_audit",
    ],
  },
  allowedInsertTriggers: {
    commerce_orders: ["trg_commerce_orders_line_sum", "commerce_orders_catalog_owner_origin_guard"],
    commerce_order_items: ["trg_commerce_order_items_line_sum", "commerce_order_items_catalog_owner_origin_guard"],
    commerce_order_holds: ["trg_fulfillment_emit_shipment_exception", "trg_subscription_delivery_alignment_exception_case"],
    commerce_order_draft_receipts: ["commerce_order_draft_receipts_catalog_final", "commerce_order_draft_receipts_catalog_owner_origin_guard"],
    commerce_order_adjustments: ["commerce_order_adjustments_catalog_final", "trg_commerce_order_adjustments_money_v2"],
    commerce_order_operations: ["communication_refund_subject"],
  },
} as const;
