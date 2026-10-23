import type { FulfillmentTrackingReference } from "./contracts/index.js";

export function trackingReferenceComplete(ref: FulfillmentTrackingReference): boolean {
  return Boolean(ref.carrierRef && ref.publicUrl && ref.serviceRef);
}
/** Provider evidence wins as a unit; private carrier/URL codecs stay injected. */
export function enrichTrackingReference(
  ref: FulfillmentTrackingReference,
  deliveryCarrier: { carrierRef: string | null; serviceRef: string | null } | null,
  codecs: {
    approveTrackingUrl?(url: string): boolean;
    normalizeCarrier(input: { carrierRef: string | null; serviceRef: string | null }): string | null;
    publicUrl(carrierRef: string | null, trackingNumber: string): string | null;
  },
): FulfillmentTrackingReference {
  const providerCarrier = ref.carrierRef ?? codecs.normalizeCarrier(ref);
  const carrierRef = providerCarrier ?? codecs.normalizeCarrier({ carrierRef: deliveryCarrier?.carrierRef ?? null, serviceRef: deliveryCarrier?.serviceRef ?? null });
  return { trackingNumber: ref.trackingNumber, publicUrl: ref.publicUrl ?? codecs.publicUrl(carrierRef, ref.trackingNumber),
    carrierRef, serviceRef: ref.serviceRef ?? (providerCarrier ? null : deliveryCarrier?.serviceRef ?? null) };
}
/** First occurrence wins, including its selection, after trimming the number. */
export function uniqueTrackingReferences(refs: readonly FulfillmentTrackingReference[]): FulfillmentTrackingReference[] {
  const seen = new Set<string>();
  const result: FulfillmentTrackingReference[] = [];
  for (const ref of refs) {
    const trackingNumber = ref.trackingNumber.trim();
    if (!trackingNumber || seen.has(trackingNumber)) continue;
    seen.add(trackingNumber);
    result.push({ trackingNumber, publicUrl: ref.publicUrl ?? null, carrierRef: ref.carrierRef ?? null, serviceRef: ref.serviceRef ?? null });
  }
  return result;
}
