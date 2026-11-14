import { createHash } from "node:crypto";
import type { FulfillmentObservation } from "../contracts/index.js";
import { normalizeStatus, type NormalizedProviderStatus } from "./omnipackStatusVocabulary.js";
import { providerOrderNumberFor } from './omnipackDispatchPayload.js';

/** The provider's normalized primary status and original occurrence bytes own status dedupe. */
export function intakeFacts(status: NormalizedProviderStatus, occurredAt: string | null): NonNullable<FulfillmentObservation["intake"]> {
  return {
    occurredAt,
    occurrenceKey: createHash("sha256").update(JSON.stringify([status, occurredAt])).digest("hex"),
    recovery: status === "suspended" ? "provider_recovered" : status === "shipping_failed" ? "delivery_only"
      : ["returned_to_sender", "cancelled"].includes(status) ? "manual" : null,
  };
}

export function reconciliationIntake(status: string | null, occurredAt: string | null) {
  const normalized = normalizeStatus(status);
  return normalized ? intakeFacts(normalized, occurredAt) : undefined;
}

/** Same outbound identity as dispatch; only recorded native order associations may resolve the fallback. */
export const omnipackIntakeOrderIdentity = {
  merchantOrderRef: (number: string): string | null => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(number) ? number.toLowerCase() : null,
  outboundOrderNumber: (order: { orderRef: string; orderNumber: string | null; parcelSequenceNo?: number }): string => providerOrderNumberFor(order.orderNumber, order.parcelSequenceNo ?? 0) ?? order.orderRef,
};
