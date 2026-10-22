import { z } from "zod";
import { admittedReference, reference } from "../dispatchProjection.js";
import { projectObservation, publicTrackingUrl } from "../observationProjection.js";
export { reference } from "../dispatchProjection.js";
import { createHash } from "node:crypto";
import { parseNormalizedFulfillmentFact } from "@openlup/core/fulfillment";
import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation, FulfillmentObservationCodecs, FulfillmentRefusal } from "../contracts/index.js";
import type { OmnipackWebhookEvidence } from "./mappers.js";
import type { OmnipackTrackingReferenceEvidence } from "./trackingReferences.js";
import { buildProviderEventId, EVENT_TO_STATUS, type OmnipackWebhookRouteEvent } from "./omnipackWebhookPayload.js";
import { localStatusFor } from "./omnipackStatusVocabulary.js";

export const refusal = (reason: FulfillmentRefusal["reason"], phase: FulfillmentRefusal["phase"], retryable = false): FulfillmentRefusal => ({ reason, phase, retryable });
export const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Share admission with the durable sink, including explicit deny allowlists. */
export function correlationReference(value: string | null | undefined, codecs: OmnipackObservationCodecs = {}): string | null {
  return admittedReference(value, codecs.approveReference);
}
export interface OmnipackObservationCodecs extends FulfillmentObservationCodecs {
  normalizeCarrier?(input: { carrierRef: string | null; serviceRef: string | null }): string | null;
}
const occurrenceTimestamp = z.iso.datetime({ offset: true });
export function timestamp(value: string | null): string | null {
  return value && occurrenceTimestamp.safeParse(value).success && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function eventKind(value: string): OmnipackWebhookRouteEvent | null {
  return Object.hasOwn(EVENT_TO_STATUS, value) ? value as OmnipackWebhookRouteEvent : null;
}
function tracking(refs: OmnipackTrackingReferenceEvidence[], codecs: OmnipackObservationCodecs, approve: (url: string) => boolean) {
  let rejectedTrackingRefs = 0, rejectedServices = 0, rejectedTrackingUrls = 0;
  const trackingRefs: FulfillmentObservation["trackingRefs"][number][] = [];
  for (const item of refs) {
    if (item.service !== null && !correlationReference(item.service, codecs)) rejectedServices++;
    if (item.trackingUrl !== null && !publicTrackingUrl(item.trackingUrl, approve, codecs.trackingUrl)) rejectedTrackingUrls++;
    const trackingNumber = correlationReference(item.trackingNumber, codecs);
    if (!trackingNumber) { rejectedTrackingRefs++; continue; }
    // Service admission precedes any derivation. A refused service cannot leak a prefix.
    const serviceRef = correlationReference(item.service, codecs);
    const carrierRef = item.service !== null && !serviceRef ? null : reference(codecs.normalizeCarrier
      ? codecs.normalizeCarrier({ carrierRef: item.carrier, serviceRef })
      : serviceRef?.split("_")[0]?.toLowerCase());
    trackingRefs.push({ trackingNumber, carrierRef, serviceRef: item.service, publicUrl: item.trackingUrl });
  }
  return { trackingRefs, rejectedTrackingRefs, rejectedServices, rejectedTrackingUrls };
}
export function observation(input: {
  evidence: OmnipackWebhookEvidence; event: FulfillmentObservation["eventKind"]; status?: CanonicalLocalFulfillmentStatus;
  receivedAt: string; rawDigest: string; evidenceRef: `evidence:${string}`;
  source: "provider_webhook" | "provider_reconciliation"; fulfillmentRef?: string;
  approveTrackingUrl: (url: string) => boolean;
  observationCodecs?: OmnipackObservationCodecs;
}): FulfillmentObservation {
  const evidence = input.evidence;
  const codecs = input.observationCodecs ?? {};
  const externalRef = correlationReference(evidence.providerOrderId, codecs);
  const providerFulfillmentRef = correlationReference(evidence.fulfilmentNumber, codecs);
  const orderNumber = correlationReference(evidence.orderNumber, codecs);
  const fulfillmentRef = reference(input.fulfillmentRef) ?? providerFulfillmentRef ?? externalRef ?? orderNumber;
  if (!fulfillmentRef || input.source === "provider_webhook" && [evidence.providerOrderId, evidence.orderNumber, evidence.fulfilmentNumber].some(value => value !== null && !correlationReference(value, codecs))) throw refusal("missing_correlation", "normalize");
  const occurredAt = timestamp(evidence.occurredAt);
  if (evidence.occurredAt && !occurredAt) throw refusal("malformed", "normalize");
  const key = buildProviderEventId(evidence);
  const normalizedTracking = tracking(evidence.trackingReferences, codecs, input.approveTrackingUrl);
  const rejectedTrackingRefs = normalizedTracking.rejectedTrackingRefs + (evidence.rejectedTrackingRefs ?? 0)
    + (evidence.rejectedServices ?? normalizedTracking.rejectedServices);
  const status = input.status ?? localStatusFor(EVENT_TO_STATUS[input.event as OmnipackWebhookRouteEvent]);
  const fact = parseNormalizedFulfillmentFact({
    schemaVersion: 1, mapperVersion: "1", factId: digest(key), providerKind: "omnipack", fulfillmentReference: reference(fulfillmentRef) ?? digest(fulfillmentRef),
    canonicalStatus: status, provenance: { source: input.source, authority: "provider_asserted" },
    occurredAt, receivedAt: input.receivedAt,
    rawEvent: { reference: input.evidenceRef, digestAlgorithm: "sha256", digest: input.rawDigest },
  }, { isCanonicalStatus: (value): value is CanonicalLocalFulfillmentStatus =>
    ["provider_received", "picking", "packed", "in_transit", "delivered", "exception", "cancelled"].includes(value) });
  return projectObservation({ fact, eventKind: input.event, eventKey: key, firstReceivedAt: input.receivedAt,
    correlation: { orderRef: null, fulfillmentRef: reference(input.fulfillmentRef), externalRef: evidence.providerOrderId, orderNumber: evidence.orderNumber, providerFulfillmentRef: evidence.fulfilmentNumber, parcelRef: null },
    trackingRefs: normalizedTracking.trackingRefs, diagnostics: { admission: {
      rejectedTrackingRefs, rejectedTrackingUrls: evidence.rejectedTrackingUrls ?? normalizedTracking.rejectedTrackingUrls,
    } } }, input.approveTrackingUrl, codecs);
}
