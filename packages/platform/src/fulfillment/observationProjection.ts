import { z } from "zod";
import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation } from "./contracts/index.js";
import { parseFulfillmentFact } from "./normalizedFulfillmentFacts.js";
import { durableStrings } from "./dispatchProjection.js";
import { FULFILLMENT_STATUS_MAP } from "./statusMap.js";

type Privacy = ReturnType<typeof durableStrings>;
const timestamp = z.iso.datetime({ offset: true });
export function projectCorrelation(value: FulfillmentObservation["correlation"], privacy = durableStrings()): FulfillmentObservation["correlation"] {
  const token = privacy.token;
  return { orderRef: value.orderRef, fulfillmentRef: value.fulfillmentRef, externalRef: token(value.externalRef),
    orderNumber: token(value.orderNumber), providerFulfillmentRef: token(value.providerFulfillmentRef), parcelRef: value.parcelRef };
}

export function projectProviderStatus(value: NonNullable<FulfillmentObservation["providerStatus"]>, privacy = durableStrings()): NonNullable<FulfillmentObservation["providerStatus"]> {
  return { primary: privacy.token(value.primary), subStatus: privacy.token(value.subStatus) };
}
export type PollEvidence = Pick<FulfillmentObservation, "correlation" | "eventKey" | "providerStatus" | "diagnostics">;
function pollEvidence(value: PollEvidence, privacy: Privacy): PollEvidence {
  return { eventKey: value.eventKey, correlation: projectCorrelation(value.correlation, privacy),
    ...(value.providerStatus ? { providerStatus: projectProviderStatus(value.providerStatus, privacy) } : {}) };
}
/** Unknown-status quarantine/ACK evidence has the same privacy boundary as observations. */
export function projectPollEvidence(value: PollEvidence): PollEvidence {
  const privacy = durableStrings(value.diagnostics?.redactedFieldCount);
  const safe = pollEvidence(value, privacy);
  return { ...safe, ...(privacy.redactedFieldCount ? { diagnostics: { redactedFieldCount: privacy.redactedFieldCount } } : {}) };
}

/** Existing query-free tracking URL codec; host approval never admits credentials/signatures. */
export function publicTrackingUrl(value: string, approve?: (url: string) => boolean): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && approve?.(url.href) ? url.href : null;
  } catch { return null; }
}
export function projectTrackingReference(value: FulfillmentObservation["trackingRefs"][number], privacy = durableStrings(), approveTrackingUrl?: (url: string) => boolean) {
  const token = privacy.token;
  return { trackingNumber: token(value.trackingNumber) ?? "redacted", carrierRef: token(value.carrierRef), serviceRef: token(value.serviceRef),
    publicUrl: token(value.publicUrl, url => publicTrackingUrl(url, approveTrackingUrl)) };
}

/** New boundary projection: arbitrary adapter properties are never durable. */
export function projectObservation(value: FulfillmentObservation, approveTrackingUrl?: (url: string) => boolean): FulfillmentObservation {
  const privacy = durableStrings(value.diagnostics?.redactedFieldCount), token = privacy.token;
  const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
  if (value.diagnostics?.refusal) {
    const { reason, phase, retryable } = value.diagnostics.refusal;
    diagnostics.refusal = { reason: token(reason) as typeof reason, phase: token(phase) as typeof phase, retryable };
  }
  if (value.diagnostics?.stockContention) diagnostics.stockContention = { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true };
  if (value.diagnostics?.annotation) diagnostics.annotation = token(value.diagnostics.annotation) as typeof value.diagnostics.annotation;
  if (value.diagnostics?.recoveredPickedReceipt) {
    const { receiptRef, closed } = value.diagnostics.recoveredPickedReceipt;
    diagnostics.recoveredPickedReceipt = { receiptRef, closed };
  }
  const fact = parseFulfillmentFact(value.fact);
  const safe = {
    ...pollEvidence(value, privacy),
    fact: { ...fact, mapperVersion: token(fact.mapperVersion) ?? "redacted" }, eventKind: (token(value.eventKind) ?? "redacted") as FulfillmentObservation["eventKind"],
    firstReceivedAt: timestamp.parse(value.firstReceivedAt),
    trackingRefs: value.trackingRefs.map(ref => projectTrackingReference(ref, privacy, approveTrackingUrl)),
  };
  if (privacy.redactedFieldCount) diagnostics.redactedFieldCount = privacy.redactedFieldCount;
  return { ...safe, ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
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
