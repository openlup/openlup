import { z } from "zod";
import { createHash } from "node:crypto";
import { parseNormalizedFulfillmentFact } from "@openlup/core/fulfillment";
import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation, FulfillmentRefusal } from "../contracts/index.js";
import type { OmnipackWebhookEvidence } from "./mappers.js";
import type { OmnipackTrackingReferenceEvidence } from "./trackingReferences.js";
import { buildProviderEventId, EVENT_TO_STATUS, type OmnipackWebhookRouteEvent } from "./omnipackWebhookPayload.js";
import { localStatusFor } from "./omnipackStatusVocabulary.js";

export const refusal = (reason: FulfillmentRefusal["reason"], phase: FulfillmentRefusal["phase"], retryable = false): FulfillmentRefusal => ({ reason, phase, retryable });
export const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** References are opaque identifiers, never arbitrary provider prose or URLs. */
export function reference(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null;
}
/** Correlation/tracking text stays opaque but may contain spaces or slashes. */
export function correlationReference(value: string | null | undefined): string | null {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const text = value.trim();
  return text && text.length <= 256 && !/[@]|[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : null;
}
export interface OmnipackObservationCodecs {
  normalizeCarrier?(input: { carrierRef: string | null; serviceRef: string | null }): string | null;
  /** Overrides query/hash policy; the adapter still requires HTTPS without credentials. */
  trackingUrl?(url: string): string | null;
}
const occurrenceTimestamp = z.iso.datetime({ offset: true });
export function timestamp(value: string | null): string | null {
  return value && occurrenceTimestamp.safeParse(value).success && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function eventKind(value: string): OmnipackWebhookRouteEvent | null {
  return Object.hasOwn(EVENT_TO_STATUS, value) ? value as OmnipackWebhookRouteEvent : null;
}
export function publicUrl(value: string | null, approve: (url: string) => boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    // Query-free URLs only: signing tokens and credentials never enter durable tracking.
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && approve(url.href) ? url.href : null;
  } catch { return null; }
}
function tracking(refs: OmnipackTrackingReferenceEvidence[], approve: (url: string) => boolean, codecs: OmnipackObservationCodecs) {
  let rejectedTrackingRefs = 0, rejectedTrackingUrls = 0;
  const trackingRefs: FulfillmentObservation["trackingRefs"][number][] = [];
  for (const item of refs) {
    const trackingNumber = correlationReference(item.trackingNumber);
    if (!trackingNumber) { rejectedTrackingRefs++; continue; }
    let url = publicUrl(item.trackingUrl, approve);
    if (item.trackingUrl && codecs.trackingUrl) {
      const candidate = codecs.trackingUrl(item.trackingUrl);
      try {
        const parsed = new URL(candidate ?? "");
        url = parsed.protocol === "https:" && !parsed.username && !parsed.password && approve(parsed.href) ? parsed.href : null;
      } catch { url = null; }
    }
    if (item.trackingUrl && !url) rejectedTrackingUrls++;
    const carrierRef = reference(codecs.normalizeCarrier ? codecs.normalizeCarrier({ carrierRef: item.carrier, serviceRef: item.service }) : item.carrierKind);
    trackingRefs.push({ trackingNumber, carrierRef, serviceRef: correlationReference(item.service), publicUrl: url });
  }
  return { trackingRefs, admission: { rejectedTrackingRefs, rejectedTrackingUrls } };
}
export function observation(input: {
  evidence: OmnipackWebhookEvidence; event: FulfillmentObservation["eventKind"]; status?: CanonicalLocalFulfillmentStatus;
  receivedAt: string; rawDigest: string; evidenceRef: `evidence:${string}`;
  source: "provider_webhook" | "provider_reconciliation"; fulfillmentRef?: string;
  approveTrackingUrl: (url: string) => boolean;
  observationCodecs?: OmnipackObservationCodecs;
}): FulfillmentObservation {
  const evidence = input.evidence;
  const externalRef = correlationReference(evidence.providerOrderId);
  const providerFulfillmentRef = correlationReference(evidence.fulfilmentNumber);
  const orderNumber = correlationReference(evidence.orderNumber);
  const fulfillmentRef = reference(input.fulfillmentRef) ?? providerFulfillmentRef ?? externalRef ?? orderNumber;
  if (!fulfillmentRef || [evidence.providerOrderId, evidence.orderNumber, evidence.fulfilmentNumber].some(value => value !== null && !correlationReference(value))) throw refusal("missing_correlation", "normalize");
  const occurredAt = timestamp(evidence.occurredAt);
  if (evidence.occurredAt && !occurredAt) throw refusal("malformed", "normalize");
  const key = buildProviderEventId(evidence);
  const normalizedTracking = tracking(evidence.trackingReferences, input.approveTrackingUrl, input.observationCodecs ?? {});
  normalizedTracking.admission.rejectedTrackingRefs += evidence.rejectedTrackingRefs ?? 0;
  const status = input.status ?? localStatusFor(EVENT_TO_STATUS[input.event as OmnipackWebhookRouteEvent]);
  const fact = parseNormalizedFulfillmentFact({
    schemaVersion: 1, mapperVersion: "1", factId: digest(key), providerKind: "omnipack", fulfillmentReference: reference(fulfillmentRef) ?? digest(fulfillmentRef),
    canonicalStatus: status, provenance: { source: input.source, authority: "provider_asserted" },
    occurredAt, receivedAt: input.receivedAt,
    rawEvent: { reference: input.evidenceRef, digestAlgorithm: "sha256", digest: input.rawDigest },
  }, { isCanonicalStatus: (value): value is CanonicalLocalFulfillmentStatus =>
    ["provider_received", "picking", "packed", "in_transit", "delivered", "exception", "cancelled"].includes(value) });
  return { fact, eventKind: input.event, eventKey: key, firstReceivedAt: input.receivedAt,
    correlation: { orderRef: null, fulfillmentRef: reference(input.fulfillmentRef), externalRef, orderNumber, providerFulfillmentRef, parcelRef: null },
    trackingRefs: normalizedTracking.trackingRefs, diagnostics: { admission: normalizedTracking.admission } };
}
