import { evaluateCommerceFulfillmentEligibility } from "./types.js";
import { accountingSummary } from "./omsAccountingVisibility.js";
import { deriveOmnipackProviderOps } from "./omnipackProviderOps.js";
import {
  buildOmsFulfillmentSummary,
  deriveOmsCustomerFulfillmentStep,
  type OmsFulfillmentOperationRow,
  type OmsFulfillmentOrderRow,
  type OmsOmnipackDispatchRefRow as OmsDispatchRefRow,
  type OmsOmnipackStatusEvidenceRow as OmsStatusEvidenceRow,
  type OmsProviderAttemptRow,
  type OmsReleasedProviderExceptionHoldRow,
  type OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import type { OmsDeliveryContactResolution, OmsOrderDetail } from "./omsContracts.js";
import {
  baseOrder,
  evaluateOperationalState,
  inventorySummary,
  paymentStatusForOrder,
} from "./omsReadModelHelpers.js";
import { paymentMethodForOrder } from "./omsPaymentMethodSummary.js";
import type { OmsOrderRowCore, OmsOrderRowCoreInput } from "./omsReadModelRows.js";

export function buildOmsOrderRowCore(input: OmsOrderRowCoreInput): OmsOrderRowCore {
  const paymentStatus = paymentStatusForOrder(input.order.id, input.paymentIntents);
  const paymentMethod = paymentMethodForOrder(input.order.id, input.paymentIntents, input.paymentAttempts);
  const inventory = inventorySummary(input.inventoryReservations, input.orderItems ?? []);
  const fulfillment = buildOmsFulfillmentSummary({
    fulfillmentOrders: input.fulfillmentOrders,
    fulfillmentOperations: input.fulfillmentOperations,
    shipmentExternalRefs: input.shipmentExternalRefs,
    providerAttempts: input.providerAttempts,
    omnipackDispatchRefs: input.dispatchRefs,
    omnipackStatusEvidence: input.statusEvidence,
  });
  const providerOps = deriveOmnipackProviderOps({
    fulfillmentOrders: input.fulfillmentOrders,
    dispatchRefs: input.dispatchRefs ?? [],
    statusEvidence: input.statusEvidence ?? [],
  });
  const customerFulfillmentStep = deriveOmsCustomerFulfillmentStep(
    input.order.status,
    fulfillment,
    input.fulfillmentOrders[0]?.delivered_at,
    input.releasedProviderExceptionHolds,
    input.statusEvidence,
    input.activeHoldCount,
  );
  const accounting = accountingSummary(input.accountingInvoice, input.accountingOutbox);
  const fulfillmentEligibility = evaluateCommerceFulfillmentEligibility({
    orderMode: input.order.mode,
    orderStatus: input.order.status,
    paymentStatus,
    subscriptionCycleStatus: input.subscriptionCycleStatus,
    activeHoldCount: input.activeHoldCount,
    hasShippingAddress: Boolean(input.order.shipping_address_id),
    inventoryStatus: inventory.status,
  });
  const operational = evaluateOperationalState({
    order: input.order,
    paymentStatus,
    activeHoldCount: input.activeHoldCount,
    inventoryStatus: inventory.status,
    fulfillmentStatus: fulfillment.status,
    fulfillmentEligibility,
    accountingStatus: accounting.status,
  });
  return {
    row: baseOrder({
      order: input.order,
      paymentStatus,
      paymentMethod,
      activeHoldCount: input.activeHoldCount,
      identity: input.identity,
      inventoryStatus: inventory.status,
      fulfillmentStatus: fulfillment.status,
      customerFulfillmentStep,
      accountingStatus: accounting.status,
      providerOpsStatus: providerOps.status,
      providerOpsSla: providerOps.sla,
      providerOrderId: providerOps.providerOrderId,
      attentionReason: operational.attentionReason,
      nextAction: operational.nextAction,
      orderItems: input.orderItems,
      orderMoney: input.orderMoney,
    }),
    paymentStatus,
    inventory,
    fulfillment,
    accounting,
    fulfillmentEligibility,
  };
}

type DeliveryContact = NonNullable<NonNullable<OmsOrderDetail["deliveryContact"]>["effective"]>;

export function buildOmsDeliveryContactProjection(input: {
  resolution: OmsDeliveryContactResolution;
  currentParcel: OmsFulfillmentOrderRow | null;
  dispatchRefs: OmsDispatchRefRow[];
}): NonNullable<OmsOrderDetail["deliveryContact"]> {
  const baseline = parseDeliveryContact(input.resolution.baseline);
  const effective = parseDeliveryContact(input.resolution.contact);
  const providerSubmissionState = deliveryContactProviderSubmissionState(input.currentParcel, input.dispatchRefs);
  const frozen = input.dispatchRefs.some(deliveryContactRefIsEffectful)
    || Boolean(input.currentParcel && !canUpdateShippingAddress(input.currentParcel.status));
  return {
    baseline, effective, scope: input.resolution.scope, source: effective?.source ?? null,
    revision: effective?.revision ?? null, digest: effective ? input.resolution.contactDigest : null,
    frozen, providerSubmissionState,
    correctionAllowed: Boolean(effective && input.resolution.contactDigest) && !frozen,
  };
}

export function deliveryContactAddress(
  contact: DeliveryContact | null,
  addressId: string | null | undefined,
): OmsOrderDetail["shippingAddress"] {
  if (!contact || !addressId) return null;
  return {
    id: addressId, label: null, line1: contact.line1, line2: contact.line2,
    city: contact.city, postalCode: contact.postalCode, country: contact.country,
    recipientName: contact.recipientName, contactPhone: contact.contactPhone,
    companyName: null, taxId: null, deliveryNotes: contact.deliveryInstructions,
    courierInstructions: contact.courierInstructions,
  };
}

export function buildCurrentDeliveryContact(input: {
  resolution: OmsDeliveryContactResolution;
  shippingAddressId: string | null | undefined;
  fulfillmentOrders: OmsFulfillmentOrderRow[];
  dispatchRefs: OmsDispatchRefRow[];
}) {
  const currentParcel = input.fulfillmentOrders[0] ?? null;
  const deliveryContact = buildOmsDeliveryContactProjection({
    resolution: input.resolution,
    currentParcel,
    dispatchRefs: currentParcel
      ? input.dispatchRefs.filter((row) => row.fulfillment_order_id === currentParcel.id)
      : [],
  });
  return {
    deliveryContact,
    effectiveShippingAddress: deliveryContactAddress(deliveryContact.effective, input.shippingAddressId),
  };
}

function parseDeliveryContact(value: unknown): DeliveryContact | null {
  const row = objectRecord(value);
  if (row.schemaVersion !== 1) return null;
  const source = nullableText(row.source);
  const revision = positiveInteger(row.revision);
  if (!source || revision === null) return null;
  return {
    schemaVersion: 1, source, revision,
    recipientName: nullableText(row.recipientName), contactEmail: nullableText(row.contactEmail),
    contactPhone: nullableText(row.contactPhone), line1: nullableText(row.line1),
    line2: nullableText(row.line2), city: nullableText(row.city),
    postalCode: nullableText(row.postalCode), country: nullableText(row.country),
    selectedDelivery: recordOrNull(row.selectedDelivery),
    deliveryInstructions: nullableText(row.deliveryInstructions),
    courierInstructions: nullableText(row.courierInstructions),
  };
}

function deliveryContactProviderSubmissionState(
  parcel: OmsFulfillmentOrderRow | null,
  dispatchRefs: OmsDispatchRefRow[],
): NonNullable<OmsOrderDetail["deliveryContact"]>["providerSubmissionState"] {
  if (!parcel) return "not_materialized";
  if (!dispatchRefs.length) return "not_started";
  const dispatchRef = dispatchRefs.find(deliveryContactRefIsEffectful) ?? dispatchRefs[0]!;
  const known = ["draft", "submitting", "created", "uncertain", "failed", "cancel_requested", "cancelled"] as const;
  return known.find((status) => status === dispatchRef.status) ?? "unknown";
}

function deliveryContactRefIsEffectful(dispatchRef: OmsDispatchRefRow | null): boolean {
  return Boolean(dispatchRef && !(dispatchRef.status === "draft" && !dispatchRef.provider_order_id));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function canUpdateShippingAddress(status: OmsOrderDetail["fulfillmentStatus"]): boolean {
  return !status || status === "created" || status === "packed" || status === "label_pending";
}
