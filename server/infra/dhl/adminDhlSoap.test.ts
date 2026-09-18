import { describe, expect, it, vi } from "vitest";
import {
  buildBookCourierEnvelope,
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  CARRIER_PROVIDER_ID,
  callCarrierSoap,
  extractCarrierPickupOrderId,
  parseStreet,
  sanitizeCarrierError,
} from "./adminDhlSoap.js";

describe("admin carrier SOAP", () => {
  it("pins the visible provider identity used by external contracts", () => {
    expect({ display: CARRIER_DISPLAY_NAME, id: CARRIER_PROVIDER_ID })
      .toEqual({ display: "DHL", id: "dhl" });
  });

  it("escapes courier payload and extracts a namespaced provider order", () => {
    const envelope = buildBookCourierEnvelope({ auth: { username: "u", password: "p" }, pickupDate: "2026-08-17", pickupTimeFrom: "10:00", pickupTimeTo: "12:00", contactPerson: "Ada", contactPhone: "123", additionalInfo: "A & B", shipmentIds: ["SHIP-1"] });
    expect(envelope).toContain("A &amp; B");
    expect(envelope).toContain("<shipmentIdList>");
    expect(extractCarrierPickupOrderId("<x:bookCourierResult xmlns:x=\"d\"><x:item>A</x:item><x:item>B</x:item></x:bookCourierResult>")).toBe("A, B");
  });

  it("keeps address parsing and provider sanitization deterministic", () => {
    expect(parseStreet("Długa 12 / 4")).toEqual({ street: "Długa", houseNumber: "12/4" });
    expect(sanitizeCarrierError("password=secret <b>failure</b>")).toBe("password: [redacted] failure");
  });

  it("uses the exact provider SOAPAction", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<ok/>" });
    await callCarrierSoap(fetchImpl, "bookCourier", "<xml/>");
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { SOAPAction: `${CARRIER_NAMESPACE}#bookCourier`, "Content-Type": "text/xml; charset=utf-8" } }));
  });
});
