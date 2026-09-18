import {
  carrierTrackingUrl,
  normalizeCarrierKind,
} from "../../../src/domains/shipping/contracts.js";

export interface OmnipackTrackingReferenceEvidence {
  trackingNumber: string;
  trackingUrl?: string | null;
  /** Raw provider carrier/platform code, e.g. "SHIPX" (InPost's ShipX). */
  carrier?: string | null;
  carrierKind?: string | null;
  service?: string | null;
}

export interface OmnipackDeliveryCarrierEvidence {
  carrierKind: string | null;
  service: string | null;
}

export function omnipackTrackingReferenceComplete(ref: OmnipackTrackingReferenceEvidence): boolean {
  return Boolean(ref.carrierKind && ref.trackingUrl && ref.service);
}

// Fill carrier kind / service / tracking URL on a provider tracking ref. The
// live feed carries bare tracking numbers (no carrier/service), so without
// this the persisted shipment_external_refs row — and the customer email link —
// stay null. Carrier evidence is taken per source, never mixed: the provider's
// own evidence (carrierKind/carrier/service) wins wholesale; the order's
// locally persisted delivery selection fills in only when the provider gave
// no carrier evidence at all.
export function enrichOmnipackTrackingReference(
  ref: OmnipackTrackingReferenceEvidence,
  deliveryCarrier: OmnipackDeliveryCarrierEvidence | null,
): { trackingNumber: string; trackingUrl: string | null; carrierKind: string | null; service: string | null } {
  const providerCarrierKind =
    ref.carrierKind ?? normalizeCarrierKind({ carrier: ref.carrier, service: ref.service });
  const carrierKind =
    providerCarrierKind ??
    normalizeCarrierKind({ carrierKind: deliveryCarrier?.carrierKind, service: deliveryCarrier?.service });
  return {
    trackingNumber: ref.trackingNumber,
    trackingUrl: ref.trackingUrl ?? carrierTrackingUrl(carrierKind, ref.trackingNumber),
    carrierKind,
    service: ref.service ?? (providerCarrierKind ? null : deliveryCarrier?.service ?? null),
  };
}

export function uniqueOmnipackTrackingReferences(input: {
  trackingReferences?: OmnipackTrackingReferenceEvidence[];
  trackingNumbers: string[];
  shippingMethods?: string[];
}): OmnipackTrackingReferenceEvidence[] {
  const refs: OmnipackTrackingReferenceEvidence[] = [
    ...(input.trackingReferences ?? []),
    ...input.trackingNumbers.map((trackingNumber, index) => {
      const service = input.shippingMethods?.[index] ?? null;
      return {
        trackingNumber,
        trackingUrl: null,
        carrierKind: carrierKindFromService(service),
        service,
      };
    }),
  ];
  const seen = new Set<string>();
  const result: OmnipackTrackingReferenceEvidence[] = [];
  for (const ref of refs) {
    const trackingNumber = ref.trackingNumber.trim();
    if (!trackingNumber || seen.has(trackingNumber)) continue;
    seen.add(trackingNumber);
    result.push({
      trackingNumber,
      trackingUrl: ref.trackingUrl ?? null,
      carrierKind: ref.carrierKind ?? null,
      service: ref.service ?? null,
    });
  }
  return result;
}

function carrierKindFromService(service: string | null): string | null {
  if (!service) return null;
  const [carrier] = service.split("_");
  return carrier ? carrier.toLowerCase() : null;
}
