// Pure payload/evidence helpers for the OmniPack webhook handler. Extracted from
// omnipackWebhookHandler.ts to keep that file under the 300-LOC production cap.
// Type-only imports from the handler keep this dependency erasable at runtime.
import { timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import {
  uniqueOmnipackTrackingReferences,
  type OmnipackTrackingReferenceEvidence,
} from "./omnipackTrackingReferences.js";
import type { NormalizedProviderStatus } from "./omnipackStatusVocabulary.js";
import type {
  OmnipackWebhookEvidence,
  OmnipackWebhookRouteEvent,
} from "./omnipackWebhookHandler.js";

// Route event -> the SAME normalized provider vocabulary the poller uses, so
// one physical moment reads identically whichever path observed it. Before W2
// this table produced a private five-token vocabulary that a second local
// mapper then translated, and that mapper defaulted every unnamed token to
// `delivered`. A total Record over the closed route set removes both: an
// unmapped route is now a compile error, not a terminal state.
export const EVENT_TO_STATUS: Record<OmnipackWebhookRouteEvent, NormalizedProviderStatus> = {
  "shipment.accepted": "new",
  "order.processing_started": "in_fulfillment",
  "order.picked": "ready_for_packing",
  "order.shipped": "shipping",
  "order.delivered": "delivered",
};

export function verifyOmnipackWebhookToken(req: VercelRequest, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const authorization = readHeader(req, "authorization");
  if (safeEqual(authorization, `Bearer ${expectedToken}`)) return true;
  if (verifyBasicAuth(authorization, expectedToken)) return true;
  return safeEqual(readHeader(req, "x-omnipack-webhook-token"), expectedToken);
}

export function buildProviderEventId(evidence: OmnipackWebhookEvidence): string {
  return [
    evidence.event,
    evidence.providerOrderId ?? evidence.orderNumber ?? "unknown-order",
    evidence.fulfilmentNumber ?? "unknown-fulfilment",
    evidence.occurredAt ?? "unknown-time",
  ].join(":");
}

export function buildStoredPayload(
  evidence: OmnipackWebhookEvidence,
  sanitizedPayload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: "omnipack",
    event: evidence.event,
    providerOrderId: evidence.providerOrderId,
    orderNumber: evidence.orderNumber,
    fulfilmentNumber: evidence.fulfilmentNumber,
    occurredAt: evidence.occurredAt,
    trackingNumbers: evidence.trackingNumbers,
    trackingReferences: uniqueTrackingReferences(evidence).map((ref) => ({
      trackingNumber: ref.trackingNumber,
      carrierKind: ref.carrierKind ?? null,
      service: ref.service ?? null,
      hasTrackingUrl: Boolean(ref.trackingUrl),
    })),
    shippingMethods: evidence.shippingMethods,
    sanitizedPayload,
  };
}

export function uniqueTrackingReferences(evidence: OmnipackWebhookEvidence): OmnipackTrackingReferenceEvidence[] {
  return uniqueOmnipackTrackingReferences({
    trackingReferences: evidence.trackingReferences,
    trackingNumbers: evidence.trackingNumbers,
    shippingMethods: evidence.shippingMethods,
  });
}

function readHeader(req: VercelRequest, name: string): string | undefined {
  const direct = req.headers[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0];
  }
  return undefined;
}

function verifyBasicAuth(authorization: string | undefined, expectedToken: string): boolean {
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  const credentials = decodeBase64(match[1]);
  if (!credentials) return false;
  const separator = credentials.indexOf(":");
  if (separator <= 0) return false;
  const username = credentials.slice(0, separator);
  if (!username.trim()) return false;
  const password = credentials.slice(separator + 1);
  if (!password) return false;
  return safeEqual(password, expectedToken);
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
