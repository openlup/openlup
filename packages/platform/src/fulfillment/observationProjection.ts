import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation } from "./contracts/index.js";
import { parseFulfillmentFact } from "./normalizedFulfillmentFacts.js";
import { FULFILLMENT_STATUS_MAP } from "./statusMap.js";

export function projectCorrelation(value: FulfillmentObservation["correlation"]): FulfillmentObservation["correlation"] {
  const { orderRef, fulfillmentRef, externalRef, orderNumber, providerFulfillmentRef, parcelRef } = value;
  return { orderRef, fulfillmentRef, externalRef, orderNumber, providerFulfillmentRef, parcelRef };
}

/** New boundary projection: arbitrary adapter properties are never durable. */
export function projectObservation(value: FulfillmentObservation): FulfillmentObservation {
  const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
  if (value.diagnostics?.refusal) {
    const { reason, phase, retryable } = value.diagnostics.refusal;
    diagnostics.refusal = { reason, phase, retryable };
  }
  if (value.diagnostics?.stockContention) diagnostics.stockContention = { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true };
  if (value.diagnostics?.annotation) diagnostics.annotation = value.diagnostics.annotation;
  if (value.diagnostics?.recoveredPickedReceipt) {
    const { receiptRef, closed } = value.diagnostics.recoveredPickedReceipt;
    diagnostics.recoveredPickedReceipt = { receiptRef, closed };
  }
  return {
    fact: parseFulfillmentFact(value.fact), eventKind: value.eventKind, eventKey: value.eventKey,
    firstReceivedAt: value.firstReceivedAt,
    correlation: projectCorrelation(value.correlation),
    trackingRefs: value.trackingRefs.map(({ trackingNumber, carrierRef, serviceRef, publicUrl }) => ({ trackingNumber, carrierRef, serviceRef, publicUrl })),
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
  };
}

const HANDOVER_STATUSES: ReadonlySet<string> = new Set(
  FULFILLMENT_STATUS_MAP.stages.filter(stage => stage.effects.handover).flatMap(stage => stage.localStatus),
);
/** Donor finished-picking boundary is narrower than the coarse packing stage. */
export const observationStatusPolicy = {
  consumesStock: (status: CanonicalLocalFulfillmentStatus) => ["packed", "in_transit", "delivered"].includes(status),
  handsOver: (status: CanonicalLocalFulfillmentStatus) => HANDOVER_STATUSES.has(status),
  suppressDispatched: (status: CanonicalLocalFulfillmentStatus) => status === "delivered",
  trackingStatus: (status: CanonicalLocalFulfillmentStatus) => status as "in_transit" | "delivered",
};
