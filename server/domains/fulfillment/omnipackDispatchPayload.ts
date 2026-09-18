import { createHash } from "node:crypto";
import {
  buildOmnipackOutboundOrderEvidence,
  buildOmnipackOutboundOrderPayload,
  type OmnipackOutboundOrderPayload,
} from "../../_lib/omnipackOutboundOrderPayload.js";
import type { OmnipackDispatchCandidate } from "./omnipackDispatchContracts.js";

export { buildOmnipackOutboundOrderEvidence as buildSanitizedEvidence };

export function buildOmnipackDispatchCommand(candidate: OmnipackDispatchCandidate) {
  const providerPayload = buildOmnipackDispatchPayloadFromCandidate(candidate);
  const sanitizedRequest = {
    ...buildOmnipackOutboundOrderEvidence(providerPayload),
    deliveryContactRevision: candidate.deliveryContact?.revision ?? 0,
  };
  return {
    providerPayload,
    sanitizedRequest,
    // The hash commits to the request that may create a real provider effect.
    // Only its digest is persisted; the PII-bearing input is never evidence.
    requestFingerprint: stableDispatchHash(providerPayload),
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
  return createHash("sha256").update(JSON.stringify(sortRecord(value))).digest("hex");
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
