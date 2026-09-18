import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import type { OrderActionKind } from "./OrderDetailSections";
import type { AddressDraft } from "./ordersPageUtils";

export type ActionMutationVariables = {
  kind: OrderActionKind;
  idempotencyKey: string;
  slotKey: string;
};

export type ActionKeySlot = {
  fingerprint: string;
  key: string;
};

export type ActionFingerprintInput = {
  addressDraft: AddressDraft;
  note: string;
  labelTrackingId: string;
  trackingStatus: string;
  fulfillmentProviderKind: string | null;
  cancelReason: string;
  markRefundedReason: string;
};

export function actionTargetId(kind: OrderActionKind, detail: OmsOrderDetail): string {
  if (kind === "release") return detail.holds.find((hold) => hold.status === "active")?.id ?? detail.orderId;
  if (["label", "handoff", "tracking", "cancel"].includes(kind)) {
    return detail.fulfillment.fulfillmentOrderId ?? detail.orderId;
  }
  return detail.orderId;
}

export function actionFingerprint(
  kind: OrderActionKind,
  detail: OmsOrderDetail,
  input: ActionFingerprintInput,
): string {
  if (kind === "updateAddress") {
    return JSON.stringify({
      address: normalizeAddressDraft(input.addressDraft),
      orderId: detail.orderId,
      expectedRevision: detail.deliveryContact?.revision ?? null,
      expectedContactDigest: detail.deliveryContact?.digest ?? null,
    });
  }
  if (kind === "note") return JSON.stringify({ orderId: detail.orderId, note: input.note.trim() });
  if (kind === "hold") {
    return JSON.stringify({ orderId: detail.orderId, reason: "manual_support", note: input.note.trim() || null });
  }
  if (kind === "release") {
    const holdId = detail.holds.find((hold) => hold.status === "active")?.id ?? null;
    return JSON.stringify({ holdId, note: input.note.trim() || null });
  }
  if (kind === "label") {
    return JSON.stringify({
      fulfillmentOrderId: detail.fulfillment.fulfillmentOrderId,
      providerKind: input.fulfillmentProviderKind,
      providerTrackingId: input.labelTrackingId.trim(),
    });
  }
  if (kind === "handoff") return JSON.stringify({ fulfillmentOrderId: detail.fulfillment.fulfillmentOrderId });
  if (kind === "tracking") {
    return JSON.stringify({
      fulfillmentOrderId: detail.fulfillment.fulfillmentOrderId,
      status: input.trackingStatus,
      providerTrackingId: detail.fulfillment.providerTrackingId ?? null,
    });
  }
  if (kind === "markRefunded") {
    return JSON.stringify({ orderId: detail.orderId, reason: input.markRefundedReason.trim() });
  }
  return JSON.stringify({
    fulfillmentOrderId: detail.fulfillment.fulfillmentOrderId,
    reason: input.cancelReason.trim(),
  });
}

export function normalizeAddressDraft(addressDraft: AddressDraft) {
  return {
    recipientName: addressDraft.recipientName.trim(),
    contactEmail: addressDraft.contactEmail.trim(),
    line1: addressDraft.line1.trim(),
    line2: addressDraft.line2.trim() || null,
    city: addressDraft.city.trim(),
    postalCode: addressDraft.postalCode.trim(),
    country: addressDraft.country.trim().toUpperCase(),
    contactPhone: addressDraft.contactPhone.trim(),
    deliveryInstructions: addressDraft.deliveryNotes.trim() || null,
    courierInstructions: addressDraft.courierInstructions.trim() || null,
  };
}
