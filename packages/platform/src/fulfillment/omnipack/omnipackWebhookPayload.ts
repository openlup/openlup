import { timingSafeEqual } from "node:crypto";
import type { OmnipackWebhookEvidence } from "./mappers.js";
import type { NormalizedProviderStatus } from "./omnipackStatusVocabulary.js";

export interface OmnipackWebhookRequest { headers: Record<string, string | string[] | undefined> }
export type OmnipackWebhookRouteEvent = "shipment.accepted" | "order.processing_started" | "order.picked" | "order.shipped" | "order.delivered";

export const EVENT_TO_STATUS: Record<OmnipackWebhookRouteEvent, NormalizedProviderStatus> = {
  "shipment.accepted": "new",
  "order.processing_started": "in_fulfillment",
  "order.picked": "ready_for_packing",
  "order.shipped": "shipping",
  "order.delivered": "delivered",
};

export function verifyOmnipackWebhookToken(req: OmnipackWebhookRequest, expectedToken: string | undefined): boolean {
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

function readHeader(req: OmnipackWebhookRequest, name: string): string | undefined {
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
