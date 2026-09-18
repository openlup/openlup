// Provider-payload extraction only. This infra layer stays free of domain
// imports (provider-infra boundary): it surfaces the feed's raw carrier
// evidence (carrier code, service, feed-supplied URL) and leaves carrier
// normalization + tracking-URL building to the fulfillment domain
// (enrichOmnipackTrackingReference + the shipping carrier registry).
export interface OmnipackTrackingReferenceEvidence {
  provider: "omnipack";
  trackingNumber: string;
  trackingUrl: string | null;
  /** Raw provider carrier/platform code, e.g. "SHIPX" (InPost's ShipX). */
  carrier: string | null;
  carrierKind: string | null;
  service: string | null;
}

export function mapOmnipackTrackingReferences(input: {
  shipments?: unknown[];
  trackingNumbers?: unknown[];
  readString: (value: unknown) => string;
  readNullableString: (value: unknown) => string | null;
  asRecord: (value: unknown) => Record<string, unknown>;
}): OmnipackTrackingReferenceEvidence[] {
  const fromShipments = (input.shipments ?? [])
    .map(input.asRecord)
    .map((shipment) => {
      const trackingNumber = input.readString(shipment.trackingNo) || input.readString(shipment.trackingNumber);
      if (!trackingNumber) return null;
      const service = input.readNullableString(shipment.shippingMethod) ?? input.readNullableString(shipment.service);
      return {
        provider: "omnipack" as const,
        trackingNumber,
        trackingUrl:
          input.readNullableString(shipment.trackingUrl) ??
          input.readNullableString(shipment.trackingURL) ??
          input.readNullableString(shipment.trackingLink) ??
          input.readNullableString(shipment.publicTrackingUrl),
        carrier: input.readNullableString(shipment.carrier) ?? input.readNullableString(shipment.carrierCode),
        carrierKind: carrierKindFromService(service),
        service,
      };
    })
    .filter((ref): ref is OmnipackTrackingReferenceEvidence => ref !== null);

  const fallbackNumbers = (input.trackingNumbers ?? [])
    .map(input.readString)
    .filter(Boolean)
    .map((trackingNumber) => ({
      provider: "omnipack" as const,
      trackingNumber,
      trackingUrl: null,
      carrier: null,
      carrierKind: null,
      service: null,
    }));

  return uniqueTrackingReferences([...fromShipments, ...fallbackNumbers]);
}

function uniqueTrackingReferences(
  refs: OmnipackTrackingReferenceEvidence[],
): OmnipackTrackingReferenceEvidence[] {
  const seen = new Set<string>();
  const result: OmnipackTrackingReferenceEvidence[] = [];
  for (const ref of refs) {
    const key = ref.trackingNumber.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...ref, trackingNumber: key });
  }
  return result;
}

function carrierKindFromService(service: string | null): string | null {
  if (!service) return null;
  const [carrier] = service.split("_");
  return carrier ? carrier.toLowerCase() : null;
}
