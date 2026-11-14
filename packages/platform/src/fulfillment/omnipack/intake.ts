import { createHash } from "node:crypto";
import type { FulfillmentObservation } from "../contracts/index.js";
import { normalizeStatus, type NormalizedProviderStatus } from "./omnipackStatusVocabulary.js";

/** The provider's normalized primary status and original occurrence bytes own status dedupe. */
export function intakeFacts(status: NormalizedProviderStatus, occurredAt: string | null): NonNullable<FulfillmentObservation["intake"]> {
  return {
    occurrenceKey: createHash("sha256").update(JSON.stringify([status, occurredAt])).digest("hex"),
    recovery: status === "suspended" ? "provider_recovered" : status === "shipping_failed" ? "delivery_only"
      : ["returned_to_sender", "cancelled"].includes(status) ? "manual" : null,
  };
}

export function reconciliationIntake(status: string | null, occurredAt: string | null) {
  const normalized = normalizeStatus(status);
  return normalized ? intakeFacts(normalized, occurredAt) : undefined;
}
