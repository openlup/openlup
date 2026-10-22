import { createHash } from "node:crypto";
import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation, FulfillmentObservationCodecs } from "./contracts/index.js";
import { parseFulfillmentFact } from "./normalizedFulfillmentFacts.js";
import { admittedReference, durableStrings, reference } from "./dispatchProjection.js";
import { FULFILLMENT_STATUS_MAP } from "./statusMap.js";

type Privacy = ReturnType<typeof durableStrings>;
export function projectCorrelation(value: FulfillmentObservation["correlation"], privacy = durableStrings(), codecs: FulfillmentObservationCodecs = {}): FulfillmentObservation["correlation"] {
  const token = (value: string | null) => privacy.token(value, text => admittedReference(text, codecs.approveReference));
  return { orderRef: token(value.orderRef), fulfillmentRef: token(value.fulfillmentRef), externalRef: token(value.externalRef),
    orderNumber: token(value.orderNumber), providerFulfillmentRef: token(value.providerFulfillmentRef), parcelRef: token(value.parcelRef) };
}

export function projectProviderStatus(value: NonNullable<FulfillmentObservation["providerStatus"]>, privacy = durableStrings()): NonNullable<FulfillmentObservation["providerStatus"]> {
  return { primary: privacy.token(value.primary), subStatus: privacy.token(value.subStatus) };
}
export type PollEvidence = Pick<FulfillmentObservation, "correlation" | "eventKey" | "providerStatus" | "diagnostics">;
function pollEvidence(value: PollEvidence, privacy: Privacy, codecs: FulfillmentObservationCodecs = {}, eventKeyCodec = reference): PollEvidence {
  return { eventKey: privacy.token(value.eventKey, eventKeyCodec) ?? createHash("sha256").update(value.eventKey).digest("hex"), correlation: projectCorrelation(value.correlation, privacy, codecs),
    ...(value.providerStatus ? { providerStatus: projectProviderStatus(value.providerStatus, privacy) } : {}) };
}
/** Unknown-status quarantine/ACK evidence has the same privacy boundary as observations. */
export function projectPollEvidence(value: PollEvidence): PollEvidence {
  const privacy = durableStrings(value.diagnostics?.redactedFieldCount);
  const safe = pollEvidence(value, privacy);
  return { ...safe, ...(privacy.redactedFieldCount ? { diagnostics: { redactedFieldCount: privacy.redactedFieldCount } } : {}) };
}

/** One URL policy: strict default, optional adopter codec, and approval at every sink. */
export function publicTrackingUrl(value: string, approve?: (url: string) => boolean, codec?: (url: string) => string | null): string | null {
  try {
    const candidate = codec ? codec(value) : value;
    if (!candidate) return null;
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password && (codec || (!url.search && !url.hash)) && approve?.(url.href) ? url.href : null;
  } catch { return null; }
}
export function projectTrackingReference(value: FulfillmentObservation["trackingRefs"][number], privacy = durableStrings(), approveTrackingUrl?: (url: string) => boolean, codecs: FulfillmentObservationCodecs = {}) {
  const token = (value: string | null) => privacy.token(value, text => admittedReference(text, codecs.approveReference));
  const serviceRef = token(value.serviceRef);
  // Even an opaque-looking derived carrier is unsafe when its service was refused.
  const carrierRef = privacy.token(value.carrierRef, text => value.serviceRef !== null && serviceRef === null ? null : reference(text));
  return { trackingNumber: token(value.trackingNumber) ?? "redacted", carrierRef, serviceRef,
    publicUrl: privacy.token(value.publicUrl, url => publicTrackingUrl(url, approveTrackingUrl, codecs.trackingUrl)) };
}

/** Validate donor composite identities against admitted components, preserving original bytes. */
function observationEventKey(value: FulfillmentObservation, codecs: FulfillmentObservationCodecs): string | null {
  if (reference(value.eventKey)) return value.eventKey;
  if (!reference(value.eventKind)) return null;
  const prefix = `${value.eventKind}:`;
  const time = value.eventKey.match(/:(unknown-time|\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))$/u)?.[1];
  if (!time || !value.eventKey.startsWith(prefix) || value.eventKey.length > 1024) return null;
  if (time === "unknown-time" ? value.fact.occurredAt !== null : Date.parse(time) !== Date.parse(value.fact.occurredAt ?? "")) return null;
  const parts = value.eventKey.slice(prefix.length, -(time.length + 1));
  const order = admittedReference(value.correlation.externalRef ?? value.correlation.orderNumber, codecs.approveReference);
  const parcel = admittedReference(value.correlation.providerFulfillmentRef, codecs.approveReference);
  for (let split = 0; split < parts.length; split++) {
    if (parts[split] !== ":") continue;
    const rawOrder = parts.slice(0, split), rawParcel = parts.slice(split + 1);
    if ((order === null ? rawOrder === "unknown-order" : admittedReference(rawOrder, codecs.approveReference) === order)
      && (parcel === null ? rawParcel === "unknown-fulfilment" : admittedReference(rawParcel, codecs.approveReference) === parcel)) return value.eventKey;
  }
  return null;
}

/** New boundary projection: arbitrary adapter properties are never durable. */
export function projectObservation(value: FulfillmentObservation, approveTrackingUrl?: (url: string) => boolean, codecs: FulfillmentObservationCodecs = {}): FulfillmentObservation {
  const privacy = durableStrings(value.diagnostics?.redactedFieldCount), token = privacy.token;
  const diagnostics: NonNullable<FulfillmentObservation["diagnostics"]> = {};
  if (value.diagnostics?.admission) {
    const count = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 0;
    diagnostics.admission = { rejectedTrackingRefs: count(value.diagnostics.admission.rejectedTrackingRefs), rejectedTrackingUrls: count(value.diagnostics.admission.rejectedTrackingUrls) };
  }
  if (value.diagnostics?.refusal) {
    const { reason, phase, retryable } = value.diagnostics.refusal;
    diagnostics.refusal = { reason: token(reason) as typeof reason, phase: token(phase) as typeof phase, retryable };
  }
  if (value.diagnostics?.stockContention) diagnostics.stockContention = { sqlState: "55P03", phase: "provider_stock_consumed", retryable: true };
  if (value.diagnostics?.annotation) diagnostics.annotation = token(value.diagnostics.annotation) as typeof value.diagnostics.annotation;
  if (value.diagnostics?.recoveredPickedReceipt) {
    const { receiptRef, closed } = value.diagnostics.recoveredPickedReceipt;
    diagnostics.recoveredPickedReceipt = { receiptRef: token(receiptRef) ?? "redacted", closed };
  }
  const fact = parseFulfillmentFact(value.fact);
  const safe = {
    ...pollEvidence(value, privacy, codecs, () => observationEventKey(value, codecs)),
    fact: { ...fact, mapperVersion: token(fact.mapperVersion) ?? "redacted" }, eventKind: (token(value.eventKind) ?? "redacted") as FulfillmentObservation["eventKind"],
    firstReceivedAt: token(value.firstReceivedAt) ?? "redacted",
    trackingRefs: value.trackingRefs.map(ref => projectTrackingReference(ref, privacy, approveTrackingUrl, codecs)),
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
