import type {
  OmsAccountingStatus,
  OmsOrderDetail,
  OmsOrderHold,
  OmsPaymentStatus,
} from "./omsContracts.js";

// Every status union below is read back out of the contract the row feeds, so a
// vocabulary can only be widened in one place. The rows are DB shapes, not
// contract shapes, so the derivation is by indexed access rather than by
// re-importing the zod schemas - this file stays type-only and carries no
// runtime import.
import type { evaluateCommerceFulfillmentEligibility, CommerceCurrency, OrderStatus } from "./types.js";
import type { PaymentAttemptStatus, PaymentIntentStatus } from "../payment/types.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
import type { CanonicalOrderMoney } from "./orderMoney.js";
import type { baseOrder, OmsOrderIdentity } from "./omsReadModelHelpers.js";
import type {
  OmsFulfillmentOperationRow, OmsFulfillmentOrderRow, OmsOmnipackDispatchRefRow,
  OmsOmnipackStatusEvidenceRow, OmsProviderAttemptRow, OmsReleasedProviderExceptionHoldRow,
  OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";

export interface OmsOrderRow {
  id: string;
  order_number: string | null;
  client_id: string | null;
  status: OrderStatus;
  mode: "one_time" | "subscription_cycle";
  currency: CommerceCurrency;
  subtotal_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  shipping_discount_cents: number | null;
  tax_cents: number | null;
  total_cents: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  subscription_id: string | null;
  subscription_cycle_id: string | null;
  shipping_address_id?: string | null;
  pet_id?: string | null;
  source_kind?: string | null;
  source_order_ref?: string | null;
  // Embedded through the order's channel foreign key, following the shape
  // `inventory_locations(code)` already uses on the reservation row.
  sales_channels?: { slug?: string | null } | null;
}

export interface OmsPaymentIntentRow {
  id: string;
  order_id: string;
  payment_id: string;
  status: PaymentIntentStatus;
  active_attempt_id: string | null;
  provider_payment_id: string | null;
  updated_at: string;
}

export interface OmsPaymentAttemptRow {
  id: string;
  payment_intent_id?: string | null;
  status: PaymentAttemptStatus;
  provider: string;
  provider_attempt_id: string | null;
  next_action_kind: string | null;
  updated_at: string;
}

export interface OmsHoldRow {
  id: string;
  order_id: string;
  status: OmsOrderHold["status"];
  reason: OmsOrderHold["reason"];
  note: string | null;
  created_at: string;
  released_at: string | null;
}

export interface OmsOperationRow {
  id: string;
  order_id: string;
  operation_type: OmsOrderDetail["operations"][number]["type"];
  hold_id: string | null;
  actor_user_id: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface OmsPaymentTransitionRow {
  id: string;
  transition_kind: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  occurred_at: string;
}

export interface OmsInventoryReservationRow {
  id: string;
  order_id: string;
  order_item_id: string | null;
  quantity: number;
  status: NonNullable<OmsOrderDetail["inventory"]["reservationStatus"]>;
  expires_at: string | null;
  location_id: string | null;
  inventory_locations?: { code?: string | null } | null;
}

export interface OmsOrderItemRow {
  id: string;
  order_id?: string;
  sku_id?: string | null;
  sku?: string | null;
  title?: string | null;
  quantity: number;
  unit_price_cents?: number | null;
  total_cents?: number | null;
  discount_allocated_cents?: number | null;
  effective_total_cents?: number | null;
  effective_net_cents?: number | null;
  vat_rate_bps?: number | null;
  product_snapshot?: Record<string, unknown> | null;
  variant_snapshot?: Record<string, unknown> | null;
}

export interface OmsCustomerRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  lifecycle_stage: string | null;
}

export interface OmsPetRow {
  id: string;
  name: string | null;
  pet_type: string | null;
  breed: string | null;
  age_label: string | null;
  weight_kg: number | string | null;
}

export interface OmsAddressRow {
  id: string;
  label?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: string | null;
  recipient_name?: string | null;
  contact_phone?: string | null;
  company_name?: string | null;
  tax_id?: string | null;
  delivery_notes?: string | null;
  courier_instructions?: string | null;
}

export interface OmsAccountingInvoiceRow {
  id: string;
  order_id: string;
  invoice_ref: string;
  status: OmsAccountingStatus | string;
  provider_kind: string | null;
  provider_invoice_number: string | null;
  ksef_status: string | null;
  total_gross_cents: number;
  currency: string;
  blocked_reason?: string | null;
  updated_at: string;
}

export interface OmsAccountingOutboxRow {
  invoice_id: string;
  status: string;
  attempt_count?: number | null;
  next_attempt_at?: string | null;
  last_error?: unknown;
  created_at?: string | null;
}

export interface OmsCommunicationDeliveryRow {
  id: string;
  purpose: string;
  template_slug: string;
  trigger_source: string;
  trigger_event: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  dedupe_key: string;
  status: OmsOrderDetail["communicationDeliveries"][number]["status"];
  provider_kind: string | null;
  provider_message_id: string | null;
  scheduled_due_at: string | null;
  expected_send_at: string | null;
  queued_at: string | null;
  first_attempt_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  terminal_at: string | null;
  last_error_code: string | null;
  outbox_event_id: string | null;
  platform_job_run_id: string | null;
  email_send_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface OmsOrderRowCoreInput {
  order: OmsOrderRow;
  activeHoldCount: number;
  paymentIntents: OmsPaymentIntentRow[];
  paymentAttempts: OmsPaymentAttemptRow[];
  identity: OmsOrderIdentity;
  orderItems?: OmsOrderItemRow[];
  inventoryReservations: OmsInventoryReservationRow[];
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  fulfillmentOperations: OmsFulfillmentOperationRow[];
  shipmentExternalRefs: OmsShipmentExternalRefRow[];
  providerAttempts?: OmsProviderAttemptRow[];
  dispatchRefs?: OmsOmnipackDispatchRefRow[];
  statusEvidence?: OmsOmnipackStatusEvidenceRow[];
  releasedProviderExceptionHolds?: OmsReleasedProviderExceptionHoldRow[];
  accountingInvoice: OmsAccountingInvoiceRow | null;
  accountingOutbox: OmsAccountingOutboxRow[];
  subscriptionCycleStatus: SubscriptionCycleStatus | null;
  orderMoney?: CanonicalOrderMoney;
}

export interface OmsOrderRowCore {
  row: ReturnType<typeof baseOrder>;
  paymentStatus: OmsPaymentStatus;
  inventory: OmsOrderDetail["inventory"];
  fulfillment: OmsOrderDetail["fulfillment"];
  accounting: OmsOrderDetail["accounting"];
  fulfillmentEligibility: ReturnType<typeof evaluateCommerceFulfillmentEligibility>;
}
