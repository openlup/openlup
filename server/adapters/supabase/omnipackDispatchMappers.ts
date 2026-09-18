import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/contracts.js";
import { parcelSequenceNo } from "../../../src/lib/currentFulfillmentParcel.js";
import type {
  OmnipackDispatchCandidate,
  OmnipackDeliveryContactSnapshot,
  OmnipackDispatchMode,
  OmnipackDispatchReadBack,
  OmnipackDispatchRefStatus,
} from "../../domains/fulfillment/omnipackDispatchContracts.js";

export interface OmnipackDispatchCandidateRow {
  id: string;
  order_id: string;
  sequence_no?: number | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  shipping_address_snapshot: {
    label?: string | null;
    // Written by every builder of this snapshot since
    // 20260831140000; absent on rows created before it.
    recipientName?: string | null;
    line1?: string | null;
    city?: string | null;
    postalCode?: string | null;
    country?: string | null;
    selectedDelivery?: Record<string, unknown> | null;
    deliveryContact?: Record<string, unknown> | null;
  };
  commerce_orders?: { order_number?: string | null; metadata?: Record<string, unknown> | null } | null;
  clients?: { email?: string | null; first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
  addresses?: { metadata?: Record<string, unknown> | null } | null;
  commerce_fulfillment_order_lines?: Array<{
    sku?: string | null;
    title?: string | null;
    quantity?: number | null;
    product_snapshot?: Record<string, unknown> | null;
  }>;
}

export const OMNIPACK_DISPATCH_CANDIDATE_SELECT = [
  "id",
  "order_id",
  "sequence_no",
  "status",
  "metadata",
  "shipping_address_snapshot",
  "commerce_orders(order_number, metadata)",
  "clients(email, first_name, last_name, phone)",
  "addresses(metadata)",
  "commerce_fulfillment_order_lines(sku, title, quantity, product_snapshot)",
].join(", ");

// The provider forces a unique external order number per dispatch, and an order that ships twice
// dispatches twice. `ERR_ORDER_NUMBER_ALREADY_EXISTS` arrives at HTTP 400, which the client
// correctly classifies as non-retryable, so a duplicate number does not retry - the second parcel
// simply never reaches the warehouse.
//
// The number is therefore a function of the *parcel*: the original keeps the order number byte for
// byte, and parcel n > 0 carries `-R{n}`. Both inputs are immutable once written, so this is
// idempotent by construction - no column, no backfill, no way for a stored value to disagree with
// the row it describes.
//
// ⛔ This suffix exists for the provider and for nobody else. It must never reach an invoice, an
// e-mail, an account page or the order-number parser: the customer's order number is the order's,
// and `src/lib/orderRef.test.ts` pins that it carries no second hyphen. Deriving it here - inside
// the one function that builds the provider request, downstream of everything the customer sees -
// is what keeps that true.
export function providerOrderNumberFor(orderNumber: string | null, sequenceNo: number): string | null {
  if (orderNumber === null || sequenceNo <= 0) return orderNumber;
  return `${orderNumber}-R${sequenceNo}`;
}

export function toOmnipackDispatchCandidate(row: OmnipackDispatchCandidateRow): OmnipackDispatchCandidate {
  const address = row.shipping_address_snapshot ?? {};
  const client = row.clients ?? {};
  const deliveryEvidence = resolveDeliverySelectionEvidence({
    fulfillmentMetadata: row.metadata,
    orderMetadata: row.commerce_orders?.metadata,
    shippingAddressSnapshot: row.shipping_address_snapshot,
    addressMetadata: row.addresses?.metadata,
  });
  return {
    fulfillmentOrderId: row.id,
    orderId: row.order_id,
    orderNumber: providerOrderNumberFor(row.commerce_orders?.order_number ?? null, parcelSequenceNo(row)),
    status: row.status,
    deliveryContact: deliveryContactFromRow(address, client, deliveryEvidence.selection),
    client: {
      email: client.email ?? null,
      firstName: client.first_name ?? null,
      lastName: client.last_name ?? null,
      phone: client.phone ?? null,
    },
    shippingAddress: {
      label: address.label ?? null,
      recipientName: address.recipientName ?? null,
      line1: address.line1 ?? "",
      city: address.city ?? "",
      postalCode: address.postalCode ?? "",
      country: address.country ?? "",
    },
    deliverySelection: deliveryEvidence.selection,
    lines: (row.commerce_fulfillment_order_lines ?? []).map((line) => ({
      sku: line.sku ?? "",
      title: line.title ?? null,
      quantity: typeof line.quantity === "number" ? line.quantity : 0,
      productSnapshot: line.product_snapshot ?? {},
    })).filter((line) => line.sku && line.quantity > 0),
  };
}

function deliveryContactFromRow(
  address: OmnipackDispatchCandidateRow["shipping_address_snapshot"],
  client: NonNullable<OmnipackDispatchCandidateRow["clients"]>,
  legacySelection: Record<string, unknown> | null,
): OmnipackDeliveryContactSnapshot {
  const frozen = objectRecordOrNull(address.deliveryContact);
  if (frozen) {
    return {
      schemaVersion: integer(frozen.schemaVersion),
      source: text(frozen.source),
      revision: integer(frozen.revision),
      recipientName: nullableText(frozen.recipientName),
      contactEmail: nullableText(frozen.contactEmail),
      contactPhone: nullableText(frozen.contactPhone),
      line1: text(frozen.line1),
      line2: nullableText(frozen.line2),
      city: text(frozen.city),
      postalCode: text(frozen.postalCode),
      country: text(frozen.country),
      selectedDelivery: objectRecordOrNull(frozen.selectedDelivery),
      deliveryInstructions: nullableText(frozen.deliveryInstructions),
      courierInstructions: nullableText(frozen.courierInstructions),
    };
  }

  const inferredRecipient = nullableText(address.recipientName)
    ?? nullableText([client.first_name, client.last_name].filter(Boolean).join(" "))
    ?? nullableText(address.label);
  return {
    schemaVersion: 1,
    source: "legacy_inferred",
    revision: 1,
    recipientName: inferredRecipient,
    contactEmail: nullableText(client.email),
    contactPhone: nullableText(client.phone),
    line1: text(address.line1),
    line2: null,
    city: text(address.city),
    postalCode: text(address.postalCode),
    country: text(address.country),
    selectedDelivery: legacySelection,
    deliveryInstructions: null,
    courierInstructions: null,
  };
}

export function toOmnipackDispatchReadBack(row: Record<string, unknown>): OmnipackDispatchReadBack {
  return {
    id: text(row.id),
    fulfillment_order_id: text(row.fulfillment_order_id),
    order_id: text(row.order_id),
    provider_order_id: nullableText(row.provider_order_id),
    dispatch_mode: text(row.dispatch_mode) as OmnipackDispatchMode,
    status: text(row.status) as OmnipackDispatchRefStatus,
    request_idempotency_key: text(row.request_idempotency_key),
    sanitized_request: objectRecord(row.sanitized_request),
  };
}

export function toOmnipackDispatchReadBackFromRpc(row: Record<string, unknown>): OmnipackDispatchReadBack {
  return {
    id: text(row.dispatchRefId),
    fulfillment_order_id: text(row.fulfillmentOrderId),
    order_id: text(row.orderId),
    provider_order_id: nullableText(row.providerOrderId),
    dispatch_mode: text(row.dispatchMode) as OmnipackDispatchMode,
    status: text(row.status) as OmnipackDispatchRefStatus,
    request_idempotency_key: text(row.requestIdempotencyKey),
    sanitized_request: objectRecord(row.sanitizedRequest),
  };
}

export function omnipackDispatchCandidateIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    if (typeof row === "string") return row;
    if (!row || typeof row !== "object") return "";
    const record = row as Record<string, unknown>;
    return text(record.fulfillment_order_id ?? record.fulfillmentOrderId);
  }).filter(Boolean);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
