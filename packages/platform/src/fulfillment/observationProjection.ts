import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation } from "./contracts/index.js";
import { parseFulfillmentFact } from "./normalizedFulfillmentFacts.js";
import { FULFILLMENT_STATUS_MAP } from "./statusMap.js";

export function projectCorrelation(value: FulfillmentObservation["correlation"]): FulfillmentObservation["correlation"] {
  const { orderRef, fulfillmentRef, externalRef, orderNumber, providerFulfillmentRef, parcelRef } = value;
  return { orderRef, fulfillmentRef, externalRef, orderNumber, providerFulfillmentRef, parcelRef };
}

export function projectProviderStatus(value: NonNullable<FulfillmentObservation["providerStatus"]>): NonNullable<FulfillmentObservation["providerStatus"]> {
  const token = (text: string | null) => typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9_ .:-]{0,127}$/u.test(text) ? text : null;
  return { primary: token(value.primary), subStatus: token(value.subStatus) };
}

/** New boundary projection: arbitrary adapter properties are never durable. */
export function projectObservation(value: FulfillmentObservation): FulfillmentObservation {
  const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
  if (value.diagnostics?.admission) {
    const count = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 0;
    diagnostics.admission = { rejectedTrackingRefs: count(value.diagnostics.admission.rejectedTrackingRefs), rejectedTrackingUrls: count(value.diagnostics.admission.rejectedTrackingUrls) };
  }
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
    ...(value.providerStatus ? { providerStatus: projectProviderStatus(value.providerStatus) } : {}),
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
