import { describe, expect, it } from "vitest";
import {
  enrichOmnipackTrackingReference,
  omnipackTrackingReferenceComplete,
  uniqueOmnipackTrackingReferences,
} from "./omnipackTrackingReferences.js";

describe("OmniPack fulfillment tracking references", () => {
  it("dedupes explicit refs before fallback numbers and infers carriers from shipping methods", () => {
    expect(uniqueOmnipackTrackingReferences({
      trackingReferences: [{
        trackingNumber: "TRK-1",
        trackingUrl: "https://inpost.example/TRK-1",
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      }],
      trackingNumbers: ["TRK-1", "DPD-2"],
      shippingMethods: ["IGNORED", "DPD_COURIER_STANDARD"],
    })).toEqual([
      {
        trackingNumber: "TRK-1",
        trackingUrl: "https://inpost.example/TRK-1",
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      },
      {
        trackingNumber: "DPD-2",
        trackingUrl: null,
        carrierKind: "dpd",
        service: "DPD_COURIER_STANDARD",
      },
    ]);
  });

  it("flags refs as complete only when carrier, service, and URL are all present", () => {
    expect(omnipackTrackingReferenceComplete({
      trackingNumber: "TRK-1",
      trackingUrl: "https://inpost.example/TRK-1",
      carrierKind: "inpost",
      service: "INPOST_PACZKOMAT",
    })).toBe(true);
    expect(omnipackTrackingReferenceComplete({ trackingNumber: "TRK-1" })).toBe(false);
    expect(omnipackTrackingReferenceComplete({
      trackingNumber: "TRK-1",
      trackingUrl: null,
      carrierKind: "inpost",
      service: "INPOST_PACZKOMAT",
    })).toBe(false);
  });

  it("enriches a bare tracking ref from the local delivery selection (live prod gap)", () => {
    expect(enrichOmnipackTrackingReference(
      { trackingNumber: "620999680605074433453432" },
      { carrierKind: "inpost", service: "inpost_locker_standard" },
    )).toEqual({
      trackingNumber: "620999680605074433453432",
      trackingUrl: "https://inpost.pl/sledzenie-przesylek?number=620999680605074433453432",
      carrierKind: "inpost",
      service: "inpost_locker_standard",
    });
  });

  it("resolves the raw provider carrier code (SHIPX) ahead of the local selection, without mixing sources", () => {
    expect(enrichOmnipackTrackingReference(
      { trackingNumber: "TRK-SHIPX", carrier: "SHIPX" },
      { carrierKind: "dpd", service: "dpd_courier_standard" },
    )).toEqual({
      trackingNumber: "TRK-SHIPX",
      trackingUrl: "https://inpost.pl/sledzenie-przesylek?number=TRK-SHIPX",
      carrierKind: "inpost",
      // The provider evidenced the carrier, so the disagreeing selection's
      // service is NOT mixed in — a dpd service next to an inpost carrier
      // would be contradictory evidence on the persisted row.
      service: null,
    });
  });

  it("never overrides provider-supplied evidence and stays null-safe without a selection", () => {
    expect(enrichOmnipackTrackingReference(
      {
        trackingNumber: "TRK-1",
        trackingUrl: "https://inpost.example/TRK-1",
        carrierKind: "inpost",
        service: "INPOST_PACZKOMAT",
      },
      { carrierKind: "dpd", service: "dpd_courier_standard" },
    )).toEqual({
      trackingNumber: "TRK-1",
      trackingUrl: "https://inpost.example/TRK-1",
      carrierKind: "inpost",
      service: "INPOST_PACZKOMAT",
    });
    expect(enrichOmnipackTrackingReference({ trackingNumber: "BARE-1" }, null)).toEqual({
      trackingNumber: "BARE-1",
      trackingUrl: null,
      carrierKind: null,
      service: null,
    });
  });
});
