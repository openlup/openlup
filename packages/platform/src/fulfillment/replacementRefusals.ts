export const FULFILLMENT_REPLACEMENT_COMMAND_REFUSALS = [
  "invalid_input",
  "idempotency_conflict",
  "order_not_found",
  "order_not_replaceable",
  "missing_client",
  "missing_shipping_address",
  "shipping_address_not_found",
  "payment_not_succeeded",
  "subscription_cycle_not_paid",
  "no_parcel_to_replace",
  "undispatched_replacement_exists",
  "missing_order_items",
  "missing_catalog_sku",
  "missing_inventory_reservation",
  "blocked_by_payment_not_succeeded_hold",
  "blocked_by_inventory_review_hold",
  "blocked_by_risk_review_hold",
  "blocked_by_address_review_hold",
  "blocked_by_manual_support_hold",
] as const;

export const FULFILLMENT_REPLACEMENT_RESERVATION_REFUSALS = [
  "inventory_external_provider_insufficient_available_stock",
  "inventory_external_provider_stock_stale",
  "inventory_external_provider_stock_missing",
  "inventory_external_provider_sku_not_found",
  "inventory_external_provider_location_missing",
  "inventory_reservation_insufficient_available_stock",
  "inventory_reservation_allocation_incomplete",
  "inventory_reservation_payment_status_not_reservable",
  "inventory_reservation_invalid_quantity",
] as const;

export const UNSPECIFIED_FULFILLMENT_REPLACEMENT_REFUSAL = "unspecified_refusal";

export const FULFILLMENT_REPLACEMENT_REFUSALS = [
  ...FULFILLMENT_REPLACEMENT_COMMAND_REFUSALS,
  ...FULFILLMENT_REPLACEMENT_RESERVATION_REFUSALS,
  UNSPECIFIED_FULFILLMENT_REPLACEMENT_REFUSAL,
] as const;

export type FulfillmentReplacementRefusal = (typeof FULFILLMENT_REPLACEMENT_REFUSALS)[number];
