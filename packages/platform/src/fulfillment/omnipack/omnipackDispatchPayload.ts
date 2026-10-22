import { createHash } from "node:crypto";
import {
  buildOmnipackOutboundOrderEvidence,
  buildOmnipackOutboundOrderPayload,
  type OmnipackOutboundOrderPayload,
  type OmnipackOutboundDeliverySelection,
} from "./omnipackOutboundOrderPayload.js";
// Structural slice consumed by the donor codec; persistence and orchestration stay outside.
export interface OmnipackDispatchCandidate {
  orderId: string;
  orderNumber: string | null;
  deliveryContact: {
    revision: number;
    recipientName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    line1: string;
    city: string;
    postalCode: string;
    country: string;
    selectedDelivery: OmnipackOutboundDeliverySelection | null;
  } | null;
  lines: Array<{ sku: string; quantity: number; productSnapshot: Record<string, unknown> }>;
}

export { buildOmnipackOutboundOrderEvidence as buildSanitizedEvidence };

export function buildOmnipackDispatchCommand(candidate: OmnipackDispatchCandidate) {
  const providerPayload = buildOmnipackDispatchPayloadFromCandidate(candidate);
  const sanitizedRequest = {
    ...buildOmnipackOutboundOrderEvidence(providerPayload),
    deliveryContactRevision: candidate.deliveryContact?.revision ?? 0,
  };
  const serialized = serializeOmnipackDispatchPayload(providerPayload);
  return {
    providerPayload,
    body: serialized.body,
    sanitizedRequest,
    // The hash commits to the request that may create a real provider effect.
    // Only its digest is persisted; the PII-bearing input is never evidence.
    requestFingerprint: serialized.requestFingerprint,
  };
}

export function buildOmnipackDispatchPayloadFromCandidate(
  candidate: OmnipackDispatchCandidate,
): OmnipackOutboundOrderPayload {
  const contact = candidate.deliveryContact;
  if (!contact) throw new Error("omnipack_order_payload_missing_delivery_contact");
  return buildOmnipackOutboundOrderPayload({
    orderNumber: candidate.orderNumber ?? candidate.orderId,
    deliverySelection: contact.selectedDelivery,
    recipient: {
      name: contact.recipientName ?? "",
      email: contact.contactEmail,
      phone: contact.contactPhone,
    },
    address: {
      line1: contact.line1,
      city: contact.city,
      postalCode: contact.postalCode,
      country: contact.country,
    },
    items: candidate.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      lotNumber: nullableText(line.productSnapshot.lotNumber ?? line.productSnapshot.lotCode),
      expirationDate: nullableText(line.productSnapshot.expirationDate ?? line.productSnapshot.expiresAt),
    })),
  });
}

export function stableDispatchHash(value: unknown): string {
  return serializeOmnipackDispatchPayload(value).requestFingerprint;
}

// Materialize once: the digest and createOrder consume these exact UTF-8 bytes.
export function serializeOmnipackDispatchPayload(value: unknown): { body: string; requestFingerprint: string } {
  const body = JSON.stringify(sortRecord(value));
  return { body, requestFingerprint: createHash("sha256").update(body).digest("hex") };
}

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecord);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort().map(([key, child]) => [key, sortRecord(child)]),
  );
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
