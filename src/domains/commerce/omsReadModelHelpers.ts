import { mapOmsPaymentStatus } from "./types.js";
import { canCancelFulfillment } from "./fulfillmentCancellationEligibility.js";
import type {
  OmsAccountingStatus,
  OmsInventoryStatus,
  OmsOrderDetail,
  OmsPaymentStatus,
} from "./omsContracts.js";
import { resolveOmsOperationalState } from "./omsOperationalLadder.js";
import { pricingSummaryForOrder } from "./omsReadModelPricing.js";
import type { CanonicalOrderMoney } from "./orderMoney.js";
import type {
  OmsAddressRow,
  OmsCustomerRow,
  OmsInventoryReservationRow,
  OmsOrderItemRow,
  OmsOrderRow,
  OmsPaymentIntentRow,
  OmsPetRow,
} from "./omsReadModelRows.js";
import type { OmsPaymentMethodSummary } from "./omsPaymentMethodSummary.js";
export { buildOmsDeliveryContactProjection, deliveryContactAddress } from "./omsReadModelRowCore.js";
// Who the row is about. One pair rather than two loose fields, so the row core
// forwards it untouched and neither builder can supply half of it.
export type OmsOrderIdentity = Pick<OmsOrderDetail, "customer" | "pet">;
export interface OmsActionAvailabilityFlags {
  holdMutationsEnabled?: boolean;
  supportMutationsEnabled?: boolean;
  fulfillmentMutationsEnabled?: boolean;
  refundMutationsEnabled?: boolean;
  orderCancellationEnabled?: boolean;
}
export function findCustomer(order: OmsOrderRow, customers: OmsCustomerRow[]): OmsOrderDetail["customer"] {
  return mapCustomer(customers.find((customer) => customer.id === order.client_id) ?? null);
}
export function mapCustomer(row: OmsCustomerRow | null): OmsOrderDetail["customer"] {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    lifecycleStage: row.lifecycle_stage,
  };
}
export function findPet(order: OmsOrderRow, pets: OmsPetRow[]): OmsOrderDetail["pet"] {
  return mapPet(pets.find((pet) => pet.id === order.pet_id) ?? null);
}
export function mapPet(row: OmsPetRow | null): OmsOrderDetail["pet"] {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    petType: row.pet_type,
    breed: row.breed,
    ageLabel: row.age_label,
    weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
  };
}
export function mapAddress(row: OmsAddressRow | null): OmsOrderDetail["shippingAddress"] {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label ?? null,
    line1: row.line1 ?? null,
    line2: row.line2 ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    country: row.country ?? null,
    recipientName: row.recipient_name ?? null,
    contactPhone: row.contact_phone ?? null,
    companyName: row.company_name ?? null,
    taxId: row.tax_id ?? null,
    deliveryNotes: row.delivery_notes ?? null,
    courierInstructions: row.courier_instructions ?? null,
  };
}
export function evaluateOperationalState(input: {
  order: OmsOrderRow;
  paymentStatus: OmsPaymentStatus;
  activeHoldCount: number;
  inventoryStatus: OmsInventoryStatus;
  fulfillmentStatus: OmsOrderDetail["fulfillmentStatus"];
  fulfillmentEligibility?: { allowed: boolean; reason: string | null };
  accountingStatus: OmsAccountingStatus;
}): Pick<OmsOrderDetail, "attentionReason" | "nextAction"> {
  // The rungs themselves live in omsOperationalLadder.ts, next to the live SQL
  // arms they mirror, so the parity test can compare the two ladders directly.
  // This function only adapts the row shapes onto the ladder's flat input.
  return resolveOmsOperationalState({
    orderStatus: input.order.status,
    activeHoldCount: input.activeHoldCount,
    paymentStatus: input.paymentStatus,
    hasShippingAddress: Boolean(input.order.shipping_address_id),
    inventoryStatus: input.inventoryStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    // An absent eligibility evaluation never blocked: the old cascade consulted
    // it only when it was supplied. `true` reproduces that exactly.
    fulfillmentAllowed: input.fulfillmentEligibility ? input.fulfillmentEligibility.allowed : true,
    accountingStatus: input.accountingStatus,
  });
}
export function actionEligibility(input: {
  fulfillmentEligibility: { allowed: boolean; reason: string | null };
  activeHoldCount: number;
  fulfillmentStatus: OmsOrderDetail["fulfillmentStatus"];
  hasFulfillmentOrder: boolean;
  hasShippingAddress: boolean;
  deliveryContact?: NonNullable<OmsOrderDetail["deliveryContact"]>;
  orderStatus: OmsOrderDetail["status"];
  orderMode: "one_time" | "subscription_cycle";
  providerCancellationConfirmed?: boolean;
  flags?: OmsActionAvailabilityFlags;
}): OmsOrderDetail["actionEligibility"] {
  const flags = {
    holdMutationsEnabled: true,
    supportMutationsEnabled: true,
    fulfillmentMutationsEnabled: true,
    refundMutationsEnabled: true,
    orderCancellationEnabled: true,
    ...input.flags,
  };
  const canCreateFulfillment = input.fulfillmentEligibility.allowed && !input.hasFulfillmentOrder;
  const canRecordLabel = input.fulfillmentStatus === "created" || input.fulfillmentStatus === "packed" || input.fulfillmentStatus === "label_pending";
  const base: OmsOrderDetail["actionEligibility"] = {
    addNote: { allowed: true, reason: null },
    createHold: input.activeHoldCount > 0 ? { allowed: false, reason: "order_already_on_hold" } : { allowed: true, reason: null },
    releaseHold: input.activeHoldCount > 0 ? { allowed: true, reason: null } : { allowed: false, reason: "no_active_hold" },
    createFulfillment: canCreateFulfillment ? { allowed: true, reason: null } : { allowed: false, reason: input.fulfillmentEligibility.reason ?? "fulfillment_order_exists" },
    updateShippingAddress: input.deliveryContact
      ? !input.deliveryContact.effective
        ? { allowed: false, reason: "missing_shipping_address" }
        : input.deliveryContact.correctionAllowed
          ? { allowed: true, reason: null }
          : { allowed: false, reason: deliveryContactRefusalReason(input.deliveryContact) }
      : !input.hasShippingAddress
        ? { allowed: false, reason: "missing_shipping_address" }
        : canUpdateShippingAddress(input.fulfillmentStatus)
          ? { allowed: true, reason: null }
          : { allowed: false, reason: "address_locked_after_label" },
    recordLabel: canRecordLabel ? { allowed: true, reason: null } : { allowed: false, reason: "fulfillment_not_ready_for_label" },
    handOff: input.fulfillmentStatus === "label_created" ? { allowed: true, reason: null } : { allowed: false, reason: "label_required_before_handoff" },
    recordTrackingEvent: canRecordTrackingEvent(input.fulfillmentStatus) ? { allowed: true, reason: null } : { allowed: false, reason: "tracking_not_ready" },
    cancelFulfillment: input.fulfillmentStatus
      ? canCancelFulfillment(input.fulfillmentStatus, {
          activeHoldCount: input.activeHoldCount,
          orderMode: input.orderMode,
          orderStatus: input.orderStatus,
          providerCancellationConfirmed: input.providerCancellationConfirmed ?? false,
        })
        ? { allowed: true, reason: null }
        : { allowed: false, reason: "fulfillment_not_cancellable" }
      : { allowed: false, reason: "no_fulfillment_order" },
    cancelOrder: input.orderStatus === "pending_payment"
      ? { allowed: true, reason: null }
      : { allowed: false, reason: "order_not_pending_payment" },
    markRefunded: input.orderStatus === "paid"
      ? { allowed: true, reason: null }
      : input.orderStatus === "refunded"
        ? { allowed: false, reason: "already_refunded" }
        : { allowed: false, reason: "order_not_paid" },
  };
  return {
    addNote: flagGate(base.addNote, flags.supportMutationsEnabled, "oms_support_mutations_disabled"),
    createHold: flagGate(base.createHold, flags.holdMutationsEnabled, "oms_hold_mutations_disabled"),
    releaseHold: flagGate(base.releaseHold, flags.holdMutationsEnabled, "oms_hold_mutations_disabled"),
    createFulfillment: flagGate(base.createFulfillment, flags.fulfillmentMutationsEnabled, "commerce_fulfillment_mutations_disabled"),
    updateShippingAddress: flagGate(base.updateShippingAddress, flags.supportMutationsEnabled, "oms_support_mutations_disabled"),
    recordLabel: flagGate(base.recordLabel, flags.fulfillmentMutationsEnabled, "commerce_fulfillment_mutations_disabled"),
    handOff: flagGate(base.handOff, flags.fulfillmentMutationsEnabled, "commerce_fulfillment_mutations_disabled"),
    recordTrackingEvent: flagGate(base.recordTrackingEvent, flags.fulfillmentMutationsEnabled, "commerce_fulfillment_mutations_disabled"),
    cancelFulfillment: flagGate(base.cancelFulfillment, flags.fulfillmentMutationsEnabled, "commerce_fulfillment_mutations_disabled"),
    cancelOrder: flagGate(base.cancelOrder, flags.orderCancellationEnabled, "oms_order_cancellation_disabled"),
    markRefunded: flagGate(base.markRefunded, flags.refundMutationsEnabled, "oms_refund_mutations_disabled"),
  };
}
function deliveryContactRefusalReason(
  projection: NonNullable<OmsOrderDetail["deliveryContact"]>,
): string {
  return ["submitting", "created", "uncertain", "failed", "cancel_requested", "cancelled", "unknown"]
    .includes(projection.providerSubmissionState)
    ? "delivery_contact_submission_started"
    : "address_locked_after_label";
}
export function inventorySummary(
  reservations: OmsInventoryReservationRow[],
  orderItems: OmsOrderItemRow[],
): OmsOrderDetail["inventory"] {
  const reservation = reservations[0] ?? null;
  if (!reservation) return emptyInventory();
  const base = {
    reservationId: reservation.id,
    reservationStatus: reservation.status,
    expiresAt: reservation.expires_at,
    locationId: reservation.location_id,
    locationCode: reservation.inventory_locations?.code ?? null,
  };
  if (orderItems.length > 0 && !hasCoverageReservation(reservations) && reservation.status !== "consumed") {
    return { status: reservation.status === "reserved" ? "reserved" : reservation.status, ...base };
  }
  if (orderItems.length > 0 && !allOrderItemsCovered(orderItems, reservations)) return { status: "missing", ...base };
  return { status: reservation.status === "reserved" ? "reserved" : reservation.status, ...base };
}
export function baseOrder(input: {
  order: OmsOrderRow;
  paymentStatus: OmsPaymentStatus;
  paymentMethod: OmsPaymentMethodSummary;
  activeHoldCount: number;
  identity: OmsOrderIdentity;
  inventoryStatus: OmsInventoryStatus;
  fulfillmentStatus: OmsOrderDetail["fulfillmentStatus"];
  customerFulfillmentStep: OmsOrderDetail["customerFulfillmentStep"];
  accountingStatus: OmsAccountingStatus;
  providerOpsStatus: OmsOrderDetail["providerOpsStatus"];
  providerOpsSla: OmsOrderDetail["providerOpsSla"];
  providerOrderId: OmsOrderDetail["providerOrderId"];
  attentionReason: OmsOrderDetail["attentionReason"];
  nextAction: OmsOrderDetail["nextAction"];
  orderItems?: OmsOrderItemRow[];
  orderMoney?: CanonicalOrderMoney;
}) {
  const pricingSummary = pricingSummaryForOrder(
    input.order,
    input.orderItems,
    input.orderMoney,
  );
  return {
    orderId: input.order.id,
    orderNumber: input.order.order_number,
    clientId: input.order.client_id,
    ...input.identity,
    status: input.order.status,
    mode: input.order.mode,
    // undefined, not null: "no source axis read" is not "storefront order".
    sourceKind: input.order.source_kind ?? undefined,
    sourceChannelSlug: input.order.sales_channels?.slug ?? undefined,
    sourceOrderRef: input.order.source_order_ref ?? undefined,
    paymentMethodLabel: input.paymentMethod.label,
    paymentProvider: input.paymentMethod.provider,
    paymentStatus: input.paymentStatus,
    fulfillmentStatus: input.fulfillmentStatus,
    customerFulfillmentStep: input.customerFulfillmentStep,
    inventoryStatus: input.inventoryStatus,
    accountingStatus: input.accountingStatus,
    providerOpsStatus: input.providerOpsStatus,
    providerOpsSla: input.providerOpsSla,
    providerOrderId: input.providerOrderId,
    attentionReason: input.attentionReason,
    nextAction: input.nextAction,
    activeHoldCount: input.activeHoldCount,
    total: pricingSummary.finalTotal,
    pricingSummary,
    createdAt: input.order.created_at,
    updatedAt: input.order.updated_at,
  };
}
export function paymentStatusForOrder(orderId: string, paymentIntents: OmsPaymentIntentRow[]) {
  const intent = paymentIntents.find((candidate) => candidate.id && candidate.order_id === orderId);
  return mapOmsPaymentStatus(intent?.status ?? null);
}
function canUpdateShippingAddress(status: OmsOrderDetail["fulfillmentStatus"]): boolean {
  return !status || status === "created" || status === "packed" || status === "label_pending";
}
function canRecordTrackingEvent(status: OmsOrderDetail["fulfillmentStatus"]): boolean {
  return status === "handed_over" || status === "in_transit";
}

function flagGate(
  eligibility: OmsOrderDetail["actionEligibility"]["addNote"],
  enabled: boolean | undefined,
  reason: string,
): OmsOrderDetail["actionEligibility"]["addNote"] {
  return enabled ? eligibility : { allowed: false, reason };
}

function allOrderItemsCovered(orderItems: OmsOrderItemRow[], reservations: OmsInventoryReservationRow[]): boolean {
  const reservedQtyByItem = new Map<string, number>();
  for (const reservation of reservations) {
    if ((reservation.status !== "reserved" && reservation.status !== "consumed") || !reservation.order_item_id) continue;
    reservedQtyByItem.set(reservation.order_item_id, (reservedQtyByItem.get(reservation.order_item_id) ?? 0) + reservation.quantity);
  }
  return orderItems.every((item) => (reservedQtyByItem.get(item.id) ?? 0) >= item.quantity);
}

function hasCoverageReservation(reservations: OmsInventoryReservationRow[]): boolean {
  return reservations.some((reservation) => reservation.status === "reserved" || reservation.status === "consumed");
}

function emptyInventory(): OmsOrderDetail["inventory"] {
  return {
    status: "missing",
    reservationId: null,
    reservationStatus: null,
    expiresAt: null,
    locationId: null,
    locationCode: null,
  };
}
