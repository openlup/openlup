import { createHash } from "node:crypto";
import { parseNormalizedFulfillmentFact } from "@openlup/core/fulfillment";
import type { CanonicalLocalFulfillmentStatus, FulfillmentObservation, FulfillmentRefusal } from "../contracts/index.js";
import type { OmnipackWebhookEvidence } from "./mappers.js";
import type { OmnipackTrackingReferenceEvidence } from "./trackingReferences.js";
import { EVENT_TO_STATUS, type OmnipackWebhookRouteEvent } from "./omnipackWebhookPayload.js";
import { localStatusFor } from "./omnipackStatusVocabulary.js";

export const refusal = (reason: FulfillmentRefusal["reason"], phase: FulfillmentRefusal["phase"], retryable = false): FulfillmentRefusal => ({ reason, phase, retryable });
export const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** References are opaque identifiers, never arbitrary provider prose or URLs. */
export function reference(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null;
}
export function timestamp(value: string | null): string | null {
  return value && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
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
function tracking(refs: OmnipackTrackingReferenceEvidence[], approve: (url: string) => boolean): FulfillmentObservation["trackingRefs"] {
  return refs.flatMap(item => {
    const trackingNumber = reference(item.trackingNumber);
    return trackingNumber ? [{ trackingNumber, carrierRef: reference(item.carrier), serviceRef: reference(item.service), publicUrl: publicUrl(item.trackingUrl, approve) }] : [];
  });
}
export function observation(input: {
  evidence: OmnipackWebhookEvidence; event: FulfillmentObservation["eventKind"]; status?: CanonicalLocalFulfillmentStatus;
  receivedAt: string; rawDigest: string; evidenceRef: `evidence:${string}`;
  source: "provider_webhook" | "provider_reconciliation"; fulfillmentRef?: string;
  approveTrackingUrl: (url: string) => boolean;
}): FulfillmentObservation {
  const evidence = input.evidence;
  const externalRef = reference(evidence.providerOrderId);
  const providerFulfillmentRef = reference(evidence.fulfilmentNumber);
  const orderNumber = reference(evidence.orderNumber);
  const fulfillmentRef = reference(input.fulfillmentRef) ?? providerFulfillmentRef ?? externalRef ?? orderNumber;
  if (!fulfillmentRef) throw refusal("missing_correlation", "normalize");
  const occurredAt = timestamp(evidence.occurredAt);
  if (evidence.occurredAt && !occurredAt) throw refusal("malformed", "normalize");
  const key = digest(JSON.stringify([input.event, externalRef ?? orderNumber, providerFulfillmentRef, occurredAt]));
  const status = input.status ?? localStatusFor(EVENT_TO_STATUS[input.event as OmnipackWebhookRouteEvent]);
  const fact = parseNormalizedFulfillmentFact({
    schemaVersion: 1, mapperVersion: "1", factId: key, providerKind: "omnipack", fulfillmentReference: fulfillmentRef,
    canonicalStatus: status, provenance: { source: input.source, authority: "provider_asserted" },
    occurredAt, receivedAt: input.receivedAt,
    rawEvent: { reference: input.evidenceRef, digestAlgorithm: "sha256", digest: input.rawDigest },
  }, { isCanonicalStatus: (value): value is CanonicalLocalFulfillmentStatus =>
    ["provider_received", "picking", "packed", "in_transit", "delivered", "exception", "cancelled"].includes(value) });
  return { fact, eventKind: input.event, eventKey: key, firstReceivedAt: input.receivedAt,
    correlation: { orderRef: null, fulfillmentRef: reference(input.fulfillmentRef), externalRef, orderNumber, providerFulfillmentRef, parcelRef: null },
    trackingRefs: tracking(evidence.trackingReferences, input.approveTrackingUrl) };
}
