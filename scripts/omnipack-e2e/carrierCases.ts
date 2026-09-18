// OmniPack live-verification carrier matrix (W4). One case per carrier the customer
// can pick in the configurator — InPost locker, DPD courier, DHL-via-OmniPack courier —
// all routed through the OmniPack 3PL (providerKind "omnipack"; the carrier is the
// transport layer, never the provider — the W8 three-layer invariant). direct-DHL is
// unit-only (no DHL sandbox on preview), so it is intentionally absent here.
//
// Each case is the canonical `selectedDelivery` payload the checkout intent carries.
// The carrierKind/serviceCode/deliveryKind triple MUST resolve to an entry in
// OMNIPACK_DELIVERY_OPTIONS. OmniPack requested carrierCode to equal serviceCode,
// so canonical cases mirror the service code in both fields. omnipack-e2e.test.ts
// drives every case through the real buildOmnipackOutboundOrderPayload so the
// matrix can never again drift from the shipping options dictionary.

export interface OmnipackCarrierCase {
  /** Stable id used for idempotency keys, run labels, and synthetic tracking. */
  id: "inpost-locker" | "dpd-courier" | "dhl-via-omnipack";
  label: string;
  /** Canonical selectedDelivery for the checkout intent. */
  selectedDelivery: {
    kind: "parcel-locker" | "courier";
    deliveryKind: "parcel-locker" | "courier";
    providerKind: "omnipack";
    providerRef: string | null;
    carrierKind: string;
    carrierCode: string;
    serviceCode: string;
    pickupPoint:
      | { id: string; provider: string; name: string; address: { line1: string; postalCode: string; city: string; country: "PL" } }
      | null;
  };
  /** Synthetic courier tracking the signed shipped/delivered webhooks will carry. */
  tracking: { trackingNo: string; shippingMethod: string; trackingUrl: string };
}

const PICKUP_ADDRESS = { line1: "ul. Testowa 1", postalCode: "00-001", city: "Warszawa", country: "PL" } as const;

export const OMNIPACK_CARRIER_CASES: readonly OmnipackCarrierCase[] = [
  {
    id: "inpost-locker",
    label: "InPost Paczkomat (via OmniPack)",
    selectedDelivery: {
      kind: "parcel-locker",
      deliveryKind: "parcel-locker",
      providerKind: "omnipack",
      providerRef: null,
      carrierKind: "inpost",
      carrierCode: "INPOST_LOCKER_STANDARD",
      serviceCode: "INPOST_LOCKER_STANDARD",
      pickupPoint: { id: "WAW01A", provider: "inpost", name: "Paczkomat WAW01A", address: PICKUP_ADDRESS },
    },
    tracking: {
      trackingNo: "E2E-INPOST-0001",
      shippingMethod: "INPOST_PACZKOMAT",
      trackingUrl: "https://inpost.example/track/E2E-INPOST-0001",
    },
  },
  {
    id: "dpd-courier",
    label: "DPD courier (via OmniPack)",
    selectedDelivery: {
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "omnipack",
      providerRef: null,
      carrierKind: "dpd",
      carrierCode: "DPD_COURIER_STANDARD",
      serviceCode: "DPD_COURIER_STANDARD",
      pickupPoint: null,
    },
    tracking: {
      trackingNo: "E2E-DPD-0002",
      shippingMethod: "DPD_CLASSIC",
      trackingUrl: "https://dpd.example/track/E2E-DPD-0002",
    },
  },
  {
    id: "dhl-via-omnipack",
    label: "DHL courier (via OmniPack)",
    selectedDelivery: {
      kind: "courier",
      deliveryKind: "courier",
      providerKind: "omnipack",
      providerRef: null,
      carrierKind: "dhl",
      carrierCode: "DHL_COURIER_STANDARD",
      serviceCode: "DHL_COURIER_STANDARD",
      pickupPoint: null,
    },
    tracking: {
      trackingNo: "E2E-DHL-0003",
      shippingMethod: "DHL_PARCEL",
      trackingUrl: "https://dhl.example/track/E2E-DHL-0003",
    },
  },
];

export function findCarrierCase(id: string): OmnipackCarrierCase | null {
  return OMNIPACK_CARRIER_CASES.find((entry) => entry.id === id) ?? null;
}
