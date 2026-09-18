import { describe, expect, it } from "vitest";
import {
  carrierTrackingUrl,
  normalizeCarrierKind,
  resolveCarrierTracking,
} from "./carrierTrackingUrls.js";

describe("carrier tracking URL registry", () => {
  // The four live production delivery options (merchant dictionary) + the
  // carrier code OmniPack actually reports (SHIPX = InPost's ShipX platform,
  // observed live 2026-07-13 on order OPENLUP-0F50280B).
  it.each([
    ["INPOST_LOCKER_STANDARD", "inpost"],
    ["INPOST_COURIER_STANDARD", "inpost"],
    ["inpost_locker_standard", "inpost"],
    ["inpost_courier_standard", "inpost"],
    ["DPD_COURIER_STANDARD", "dpd"],
    ["dpd_courier_standard", "dpd"],
    ["DHL_COURIER_STANDARD", "dhl"],
    ["dhl_courier_standard", "dhl"],
  ])("maps live service code %s to carrier kind %s", (service, kind) => {
    expect(normalizeCarrierKind({ service })).toBe(kind);
  });

  it("maps the SHIPX carrier code to inpost", () => {
    expect(normalizeCarrierKind({ carrier: "SHIPX" })).toBe("inpost");
  });

  it("passes an explicit carrier kind through and prefers URL-known evidence", () => {
    expect(normalizeCarrierKind({ carrierKind: "inpost" })).toBe("inpost");
    expect(normalizeCarrierKind({ carrierKind: "DPD" })).toBe("dpd");
    // An unrecognized leading token loses to later evidence with a known URL.
    expect(normalizeCarrierKind({ carrier: "WEIRD", service: "inpost_locker_standard" })).toBe("inpost");
    // …but stays informative when nothing resolves to a known carrier.
    expect(normalizeCarrierKind({ service: "gls_standard" })).toBe("gls");
  });

  it("returns null when no carrier evidence is provided", () => {
    expect(normalizeCarrierKind({})).toBeNull();
    expect(normalizeCarrierKind({ carrierKind: null, carrier: "  ", service: null })).toBeNull();
  });

  it("builds the InPost tracking URL", () => {
    expect(carrierTrackingUrl("inpost", "620999680605074433453432")).toBe(
      "https://inpost.pl/sledzenie-przesylek?number=620999680605074433453432",
    );
  });

  it("builds the DPD tracking URL", () => {
    expect(carrierTrackingUrl("dpd", "0123456789ABC")).toBe(
      "https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0123456789ABC",
    );
  });

  it("builds the DHL tracking URL (matches the legacy adapter builder)", () => {
    expect(carrierTrackingUrl("dhl", "JD0123456789")).toBe(
      "https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=JD0123456789",
    );
  });

  it("URL-encodes the tracking number", () => {
    expect(carrierTrackingUrl("inpost", "A B/C")).toBe(
      "https://inpost.pl/sledzenie-przesylek?number=A%20B%2FC",
    );
  });

  it("returns null for unknown carriers and blank tracking numbers", () => {
    expect(carrierTrackingUrl("gls", "123")).toBeNull();
    expect(carrierTrackingUrl(null, "123")).toBeNull();
    expect(carrierTrackingUrl("inpost", "")).toBeNull();
    expect(carrierTrackingUrl("inpost", "   ")).toBeNull();
    expect(carrierTrackingUrl("inpost", null)).toBeNull();
  });

  it("resolves kind + URL in one step (the live prod gap scenario)", () => {
    expect(
      resolveCarrierTracking(
        { carrier: "SHIPX", service: "inpost_locker_standard" },
        "620999680605074433453432",
      ),
    ).toEqual({
      carrierKind: "inpost",
      trackingUrl: "https://inpost.pl/sledzenie-przesylek?number=620999680605074433453432",
    });
    expect(resolveCarrierTracking({}, "620999680605074433453432")).toEqual({
      carrierKind: null,
      trackingUrl: null,
    });
  });
});
