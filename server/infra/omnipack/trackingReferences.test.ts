import { describe, expect, it } from "vitest";
import { mapOmnipackTrackingReferences } from "./trackingReferences.js";

const readString = (value: unknown) => (typeof value === "string" ? value : "");
const readNullableString = (value: unknown) =>
  typeof value === "string" && value ? value : null;
const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

describe("OmniPack infra tracking references", () => {
  it("maps shipment tracking refs with carrier metadata and keeps missing URLs explicit", () => {
    const refs = mapOmnipackTrackingReferences({
      shipments: [
        {
          trackingNo: "INPOST-1",
          shippingMethod: "INPOST_PACZKOMAT",
          trackingUrl: "https://inpost.example/INPOST-1",
        },
        { trackingNo: "DPD-1", shippingMethod: "DPD_COURIER_STANDARD" },
      ],
      trackingNumbers: ["INPOST-1", "LEGACY-1"],
      readString,
      readNullableString,
      asRecord,
    });

    expect(refs).toEqual([
      {
        provider: "omnipack",
        trackingNumber: "INPOST-1",
        trackingUrl: "https://inpost.example/INPOST-1",
        carrier: null,
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      },
      {
        provider: "omnipack",
        trackingNumber: "DPD-1",
        // No URL is synthesized here — infra stays payload-extraction-only; the
        // fulfillment domain (enrichOmnipackTrackingReference) builds URLs.
        trackingUrl: null,
        carrier: null,
        carrierKind: "dpd",
        service: "DPD_COURIER_STANDARD",
      },
      {
        provider: "omnipack",
        trackingNumber: "LEGACY-1",
        trackingUrl: null,
        carrier: null,
        carrierKind: null,
        service: null,
      },
    ]);
  });

  it("surfaces the raw carrier code when the service is absent (live prod shape: SHIPX)", () => {
    const refs = mapOmnipackTrackingReferences({
      shipments: [{ trackingNo: "620999680605074433453432", carrier: "SHIPX" }],
      trackingNumbers: [],
      readString,
      readNullableString,
      asRecord,
    });

    expect(refs).toEqual([
      {
        provider: "omnipack",
        trackingNumber: "620999680605074433453432",
        trackingUrl: null,
        carrier: "SHIPX",
        carrierKind: null,
        service: null,
      },
    ]);
  });
});
