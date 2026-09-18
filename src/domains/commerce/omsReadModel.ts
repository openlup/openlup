import {
  buildOmsFulfillmentDebug,
  type OmsFulfillmentProviderStockCurrentRow,
  type OmsInboundProviderEventRow,
} from "./omsFulfillmentDebug.js";
import {
  type OmsFulfillmentOperationRow,
  type OmsFulfillmentOrderRow,
  type OmsOmnipackDispatchRefRow,
  type OmsOmnipackStatusEvidenceRow,
  type OmsProviderAttemptRow,
  type OmsReleasedProviderExceptionHoldRow,
  type OmsShipmentExternalRefRow,
} from "./omsFulfillmentSummary.js";
import {
  adminCommerceOrderDetailResponseSchema,
  type AdminCommerceOrderDetailResponse,
  type OmsDeliveryContactResolution,
  type OmsOrderDetail,
} from "./omsContracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { parcelSequenceNo } from "../../lib/currentFulfillmentParcel.js";
import type { SubscriptionCycleStatus } from "../subscription/types.js";
import { enrichBillingWithInvoiceBuyer } from "./omsBillingInvoiceBuyer.js";
import { mapCommunicationDelivery } from "./omsReadModelCommunication.js";
import {
  resolveDeliverySelectionEvidence,
  summarizeDeliverySelection,
} from "../shipping/contracts.js";
import {
  actionEligibility,
  mapAddress,
  mapCustomer,
  mapPet,
  type OmsActionAvailabilityFlags,
} from "./omsReadModelHelpers.js";
import { buildCurrentDeliveryContact, buildOmsOrderRowCore } from "./omsReadModelRowCore.js";
import { mapOmsOrderLine } from "./omsOrderLineMoney.js";
import { deriveOmsOrderMoney } from "./omsReadModelPricing.js";
import { omsFirstSubscriptionPricePresentation } from "./omsFirstSubscriptionPricePresentation.js";
import type { OmsAccountingInvoiceRow, OmsAccountingOutboxRow, OmsAddressRow, OmsCommunicationDeliveryRow, OmsCustomerRow, OmsHoldRow, OmsInventoryReservationRow, OmsOperationRow, OmsOrderItemRow, OmsOrderRow, OmsPaymentAttemptRow, OmsPaymentIntentRow, OmsPaymentTransitionRow, OmsPetRow } from "./omsReadModelRows.js";

export type { OmsAccountingInvoiceRow, OmsAccountingOutboxRow, OmsAddressRow, OmsCommunicationDeliveryRow, OmsCustomerRow, OmsHoldRow, OmsInventoryReservationRow, OmsOperationRow, OmsOrderItemRow, OmsOrderRow, OmsPaymentAttemptRow, OmsPaymentIntentRow, OmsPaymentTransitionRow, OmsPetRow } from "./omsReadModelRows.js";
export { buildOmsOrderListResponse } from "./omsReadModelList.js";

export function buildOmsOrderDetailResponse(input: {
  order: OmsOrderRow;
  paymentIntent: OmsPaymentIntentRow | null;
  paymentAttempts: OmsPaymentAttemptRow[];
  paymentTransitions: OmsPaymentTransitionRow[];
  holds: OmsHoldRow[];
  operations: OmsOperationRow[];
  customer?: OmsCustomerRow | null;
  pet?: OmsPetRow | null;
  shippingAddress?: OmsAddressRow | null;
  billingAddress?: OmsAddressRow | null;
  accountingInvoice?: OmsAccountingInvoiceRow | null;
  accountingOutbox?: OmsAccountingOutboxRow[];
  communicationDeliveries?: OmsCommunicationDeliveryRow[];
  orderItems?: OmsOrderItemRow[];
  inventoryReservations?: OmsInventoryReservationRow[];
  fulfillmentOrders?: OmsFulfillmentOrderRow[]; fulfillmentOperations?: OmsFulfillmentOperationRow[];
  supersededFulfillmentOrders?: OmsFulfillmentOrderRow[];
  shipmentExternalRefs?: OmsShipmentExternalRefRow[]; providerAttempts?: OmsProviderAttemptRow[];
  omnipackDispatchRefs?: OmsOmnipackDispatchRefRow[]; omnipackStatusEvidence?: OmsOmnipackStatusEvidenceRow[];
  releasedProviderExceptionHolds?: OmsReleasedProviderExceptionHoldRow[];
  fulfillmentHealth?: OmsOrderDetail["fulfillmentHealth"];
  inboundProviderEvents?: OmsInboundProviderEventRow[];
  providerStockCurrent?: OmsFulfillmentProviderStockCurrentRow[];
  subscriptionCycleStatus: SubscriptionCycleStatus | null;
  subscriptionCyclePaidAt?: string | null;
  subscriptionNextCycleAt?: string | null;
  actionFlags?: OmsActionAvailabilityFlags;
  deliveryContactResolution?: OmsDeliveryContactResolution;
}): AdminCommerceOrderDetailResponse {
  const activeHoldCount = input.holds.filter((hold) => hold.status === "active").length;
  const orderItems = input.orderItems;
  const orderMoney = deriveOmsOrderMoney(input.order, orderItems);
  const {
    row: order,
    paymentStatus,
    inventory,
    fulfillment,
    accounting,
    fulfillmentEligibility,
  } = buildOmsOrderRowCore({
    order: input.order,
    activeHoldCount,
    paymentIntents: input.paymentIntent ? [input.paymentIntent] : [],
    paymentAttempts: input.paymentAttempts,
    identity: { customer: mapCustomer(input.customer ?? null), pet: mapPet(input.pet ?? null) },
    orderItems,
    inventoryReservations: input.inventoryReservations ?? [],
    fulfillmentOrders: input.fulfillmentOrders ?? [],
    fulfillmentOperations: input.fulfillmentOperations ?? [],
    shipmentExternalRefs: input.shipmentExternalRefs ?? [],
    providerAttempts: input.providerAttempts ?? [],
    dispatchRefs: input.omnipackDispatchRefs ?? [],
    statusEvidence: input.omnipackStatusEvidence ?? [],
    releasedProviderExceptionHolds: input.releasedProviderExceptionHolds,
    accountingInvoice: input.accountingInvoice ?? null,
    accountingOutbox: input.accountingOutbox ?? [],
    subscriptionCycleStatus: input.subscriptionCycleStatus,
    orderMoney,
  });
  const fulfillmentHealth = buildOmsFulfillmentHealth({ orderId: input.order.id, fulfillmentHealth: input.fulfillmentHealth });
  const { deliveryContact, effectiveShippingAddress } = buildCurrentDeliveryContact({
    resolution: input.deliveryContactResolution ?? { resolutionVersion: 1, scope: "missing", baseline: null, contact: null, contactDigest: null },
    shippingAddressId: input.order.shipping_address_id,
    fulfillmentOrders: input.fulfillmentOrders ?? [],
    dispatchRefs: input.omnipackDispatchRefs ?? [],
  });
  const detail: OmsOrderDetail = {
    ...order,
    activeHoldReasons: [...new Set(input.holds.filter((hold) => hold.status === "active").map((hold) => hold.reason))],
    fulfillmentHealthDigest: { healthStatus: fulfillmentHealth.healthStatus, attentionReasons: fulfillmentHealth.attentionReasons },
    firstSubscriptionPricePresentation: omsFirstSubscriptionPricePresentation(
      input.order, orderItems, orderMoney,
    ),
    shippingAddress: deliveryContact.scope === "missing"
      ? mapAddress(input.shippingAddress ?? null)
      : effectiveShippingAddress,
    deliveryContact,
    billingAddress: enrichBillingWithInvoiceBuyer(
      mapAddress(input.billingAddress ?? input.shippingAddress ?? null),
      input.order.metadata,
    ),
    deliverySelection: (() => {
      const evidence = resolveDeliverySelectionEvidence({ orderMetadata: input.order.metadata });
      const summary = summarizeDeliverySelection(evidence.selection, evidence.source);
      return summary ? { ...summary, source: summary.source ?? null } : null;
    })(),
    lines: (orderItems ?? []).map((item, index) =>
      mapOmsOrderLine(item, input.order.currency, orderMoney.lines[index]!),
    ),
    subscription: {
      subscriptionId: input.order.subscription_id,
      subscriptionCycleId: input.order.subscription_cycle_id,
      subscriptionCycleStatus: input.subscriptionCycleStatus,
      nextCycleAt: input.subscriptionNextCycleAt ?? null,
      cyclePaidAt: input.subscriptionCyclePaidAt ?? null,
    },
    fulfillmentEligibility,
    inventory,
    fulfillment,
    replacementChain: buildOmsReplacementChain({
      currentParcel: (input.fulfillmentOrders ?? [])[0] ?? null,
      supersededParcels: input.supersededFulfillmentOrders ?? [],
      shipmentExternalRefs: input.shipmentExternalRefs ?? [],
    }),
    fulfillmentHealth,
    fulfillmentDebug: buildOmsFulfillmentDebug({
      paymentStatus,
      inventory,
      fulfillment,
      reservations: input.inventoryReservations ?? [],
      communicationDeliveries: input.communicationDeliveries ?? [],
      providerAttempts: input.providerAttempts ?? [],
      omnipackDispatchRefs: input.omnipackDispatchRefs ?? [],
      omnipackStatusEvidence: input.omnipackStatusEvidence ?? [],
      inboundProviderEvents: input.inboundProviderEvents ?? [],
      providerStockCurrent: input.providerStockCurrent ?? [],
    }),
    accounting,
    actionEligibility: actionEligibility({
      fulfillmentEligibility,
      activeHoldCount,
      fulfillmentStatus: fulfillment.status,
      hasFulfillmentOrder: Boolean(fulfillment.fulfillmentOrderId),
      hasShippingAddress: Boolean(input.order.shipping_address_id),
      deliveryContact,
      orderStatus: input.order.status,
      orderMode: input.order.mode,
      providerCancellationConfirmed: hasLatestOmnipackCancellation(
        input.omnipackStatusEvidence ?? [],
        fulfillment.fulfillmentOrderId,
      ),
      flags: input.actionFlags,
    }),
    holds: input.holds.map((hold) => ({
      id: hold.id,
      orderId: hold.order_id,
      status: hold.status,
      reason: hold.reason,
      note: hold.note,
      createdAt: hold.created_at,
      releasedAt: hold.released_at,
    })),
    operations: input.operations.map((operation) => ({
      id: operation.id,
      orderId: operation.order_id,
      type: operation.operation_type,
      holdId: operation.hold_id,
      actorUserId: operation.actor_user_id,
      occurredAt: operation.occurred_at,
      payload: operation.payload,
    })),
    payment: {
      intentId: input.paymentIntent?.id ?? null,
      paymentId: input.paymentIntent?.payment_id ?? null,
      status: paymentStatus,
      activeAttemptId: input.paymentIntent?.active_attempt_id ?? null,
      providerPaymentId: input.paymentIntent?.provider_payment_id ?? null,
      updatedAt: input.paymentIntent?.updated_at ?? null,
    },
    paymentAttempts: input.paymentAttempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      provider: attempt.provider,
      providerAttemptId: attempt.provider_attempt_id,
      nextActionKind: attempt.next_action_kind,
      updatedAt: attempt.updated_at,
    })),
    paymentTransitions: input.paymentTransitions.map((transition) => ({
      id: transition.id,
      transitionKind: transition.transition_kind,
      fromStatus: transition.from_status,
      toStatus: transition.to_status,
      reason: transition.reason,
      occurredAt: transition.occurred_at,
    })),
    communicationDeliveries: (input.communicationDeliveries ?? []).map(mapCommunicationDelivery),
  };

  return adminCommerceOrderDetailResponseSchema.parse({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    order: detail,
  });
}

function hasLatestOmnipackCancellation(
  evidence: OmsOmnipackStatusEvidenceRow[],
  fulfillmentOrderId: string | null,
): boolean {
  if (!fulfillmentOrderId) return false;
  const latest = evidence
    .filter((row) => row.fulfillment_order_id === fulfillmentOrderId)
    .sort((left, right) => evidenceTimestamp(right) - evidenceTimestamp(left))[0];
  return latest?.provider_status?.trim().toUpperCase() === "CANCELLED";
}

function evidenceTimestamp(row: OmsOmnipackStatusEvidenceRow): number {
  const raw = row.occurred_at ?? row.created_at;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The order's replacement chain, from rows the detail read already holds.
 *
 * ⛔ Attribution here is STRICT, unlike `rowsForParcel`: a tracking reference that names no
 * parcel belongs to whichever parcel is asking, which is right for the current parcel and
 * wrong here - it would print one legacy reference under every superseded parcel as if the
 * carrier had issued it several times. A superseded parcel shows only references that name it.
 */
function buildOmsReplacementChain(input: {
  currentParcel: OmsFulfillmentOrderRow | null;
  supersededParcels: OmsFulfillmentOrderRow[];
  shipmentExternalRefs: OmsShipmentExternalRefRow[];
}): OmsOrderDetail["replacementChain"] {
  return {
    sequenceNo: input.currentParcel ? parcelSequenceNo(input.currentParcel) : 0,
    replacesFulfillmentOrderId: input.currentParcel?.replaces_fulfillment_order_id ?? null,
    replacementReason: input.currentParcel?.replacement_reason ?? null,
    supersededParcels: input.supersededParcels.map((parcel) => ({
      fulfillmentOrderId: parcel.id,
      sequenceNo: parcelSequenceNo(parcel),
      status: parcel.status ?? null,
      replacementReason: parcel.replacement_reason ?? null,
      handedOverAt: parcel.handed_over_at ?? null,
      deliveredAt: parcel.delivered_at ?? null,
      trackingReferences: input.shipmentExternalRefs
        .filter((ref) => ref.fulfillment_order_id === parcel.id && ref.active !== false && Boolean(ref.provider_tracking_id))
        .map((ref) => ({
          providerKind: ref.provider_kind ?? "unknown",
          trackingNumber: ref.provider_tracking_id,
          trackingUrl: ref.tracking_url ?? null,
          carrierKind: ref.carrier_kind ?? ref.provider_kind ?? null,
          service: ref.service ?? null,
          updatedAt: ref.updated_at ?? ref.created_at ?? null,
        })),
    })),
  };
}

function buildOmsFulfillmentHealth(input: {
  orderId: string;
  fulfillmentHealth?: OmsOrderDetail["fulfillmentHealth"];
}): OmsOrderDetail["fulfillmentHealth"] {
  return input.fulfillmentHealth ?? {
    healthStatus: "ok",
    attentionReasons: [],
    oldestAgeSeconds: null,
    opaqueIds: {
      orderId: input.orderId,
      fulfillmentOrderId: null,
      outboxEventId: null,
      dispatchRefFulfillmentOrderId: null,
      latestEvidenceFulfillmentOrderId: null,
    },
  };
}
